import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, PROFILE_FIELDS } from './store.js';
import { createMailer } from './mailer.js';
import { createSms } from './sms.js';
import { validateProfile, parseIdentifier, normalizePhone, isEmail, STATES, GENDERS, INTERESTS } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// ---- Tunables ---------------------------------------------------------------
const CODE_TTL_MS = 10 * 60 * 1000;          // a code is valid for 10 minutes
const CODE_MAX_ATTEMPTS = 5;                 // wrong guesses before the code is burned
const RESEND_COOLDOWN_MS = 60 * 1000;        // one new code per email/phone per minute
const IP_SEND_LIMIT = 10;                    // codes one IP address can request per hour (protects SMS credit)
const COOKIE_NAME = 'sid';
// Browsers cap cookie lifetime at ~400 days, so the cookie is refreshed on visits.
// The session itself never expires: only logging out ends it.
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

const store = await createStore();
const mailer = createMailer();
const sms = createSms();
// Phone sign-in works in development (codes go to the console) and in production once an SMS provider is set.
const SMS_ENABLED = Boolean(sms.provider) || !IS_PROD;

if (IS_PROD && store.kind !== 'postgres') {
  console.warn('WARNING: running in production without DATABASE_URL. On hosts with a temporary disk ' +
    '(like Render free), every restart will sign everyone out. Set DATABASE_URL to a Postgres database.');
}
if (IS_PROD && !mailer.provider) {
  console.warn('WARNING: no email provider configured (BREVO_API_KEY, GMAIL_SCRIPT_URL, RESEND_API_KEY or SMTP_HOST).');
}
if (IS_PROD && !sms.provider) {
  console.warn('NOTE: no SMS provider configured (TERMII_API_KEY or TWILIO_*). Phone sign-in is off; email still works.');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const mask = (id) => (id.type === 'email'
  ? id.value.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '•'.repeat(Math.min(b.length, 6)) + c)
  : id.value.replace(/^(\+234)(\d{3})\d{4}(\d{3})$/, '$1 $2 ••• •$3'));

const publicMember = (m) => {
  const out = {
    email: m.email || '', emailVerified: Boolean(m.email_verified),
    phone: m.phone || '', phoneVerified: Boolean(m.phone_verified),
    createdAt: m.created_at,
    profileComplete: Boolean(m.consent_at),
  };
  for (const f of PROFILE_FIELDS) out[f] = m[f];
  out.interests = m.interests ? m.interests.split(', ') : [];
  return out;
};

// Very small in-memory limiter: N code requests per IP per hour.
const ipHits = new Map();
function ipAllowed(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (hits.length >= IP_SEND_LIMIT) { ipHits.set(ip, hits); return false; }
  hits.push(now); ipHits.set(ip, hits);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) if (!hits.some((t) => now - t < 60 * 60 * 1000)) ipHits.delete(ip);
}, 10 * 60 * 1000).unref();

// ---- App --------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);                   // Render (and most hosts) sit behind a proxy
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

// Wrap async route handlers so errors reach the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Basic CSRF defence: state-changing API calls must be JSON (forms can't send that
// cross-site without a CORS preflight) and the session cookie is SameSite=Lax.
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Expected JSON.' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

// Loads the member from the session cookie (if any) and keeps the cookie fresh.
app.use(h(async (req, res, next) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return next();
  const s = await store.getSession(sha256(token));
  const member = s && (await store.memberById(s.member_id));
  if (!member) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return next();
  }
  req.member = member;
  req.sessionHash = s.token_hash;
  // Refresh at most once an hour to avoid a write per request.
  if (Date.now() - s.last_seen > 60 * 60 * 1000) {
    await store.touchSession(s.token_hash, Date.now());
    setSessionCookie(res, token);
  }
  next();
}));

// Options for the forms, so the browser and server use the same lists.
app.get('/api/options', (req, res) =>
  res.json({ states: STATES, genders: GENDERS, interests: INTERESTS, sms: SMS_ENABLED }));

// Step 1 (sign up AND log in): email or phone -> code
app.post('/api/auth/start', h(async (req, res) => {
  const id = parseIdentifier(req.body.identifier);
  if (!id) {
    return res.status(400).json({ error: 'Enter a valid email address or Nigerian phone number (e.g. 0803 123 4567).' });
  }
  if (id.type === 'phone' && !SMS_ENABLED) {
    return res.status(503).json({ error: "Sign-in by phone isn't available yet. Please use your email address.", code: 'sms_off' });
  }

  const existing = await store.getCode(id.value);
  const now = Date.now();
  if (existing && now - existing.sent_at < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.sent_at)) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.`, retryAfter: wait });
  }
  if (!ipAllowed(req.ip)) {
    return res.status(429).json({ error: 'Too many codes requested from this connection. Try again in an hour.' });
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await store.upsertCode(id.value, id.type, sha256(`${id.value}:${code}`), now + CODE_TTL_MS, now);

  try {
    if (id.type === 'email') await mailer.send(id.value, code);
    else await sms.send(id.value, code);
  } catch (err) {
    console.error(`${id.type === 'email' ? 'Email' : 'SMS'} send failed:`, err.message);
    await store.deleteCode(id.value);
    return res.status(502).json({
      error: id.type === 'email'
        ? "We couldn't send the email. Check the address and try again shortly."
        : "We couldn't send the text message. Check the number, or use your email instead.",
    });
  }

  const body = { ok: true, type: id.type, identifier: id.value, sentTo: mask(id), cooldown: RESEND_COOLDOWN_MS / 1000 };
  // Without a provider in development, hand the code to the UI so the flow can be tested.
  const noProvider = id.type === 'email' ? !mailer.provider : !sms.provider;
  if (noProvider && !IS_PROD) body.devCode = code;
  res.json(body);
}));

// Step 2: confirm the code -> log in (creating the account the first time)
app.post('/api/auth/verify', h(async (req, res) => {
  const id = parseIdentifier(req.body.identifier);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!id || code.length !== 6) {
    return res.status(400).json({ error: 'Enter the 6-digit code we sent you.' });
  }

  const row = await store.getCode(id.value);
  if (!row || row.expires_at < Date.now()) {
    if (row) await store.deleteCode(id.value);
    return res.status(400).json({ error: 'That code has expired. Request a new one.', expired: true });
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await store.deleteCode(id.value);
    return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.', expired: true });
  }
  if (!safeEqual(sha256(`${id.value}:${code}`), row.code_hash)) {
    await store.bumpAttempts(id.value);
    const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
    return res.status(400).json({
      error: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Request a new code.',
      expired: left <= 0,
    });
  }

  // Code is good: single use.
  await store.deleteCode(id.value);

  const now = Date.now();
  const { member, isNew } = await store.signInWith(id.type, id.value, now);
  const token = crypto.randomBytes(32).toString('base64url');
  await store.insertSession(sha256(token), member.id, now, String(req.get('user-agent') || '').slice(0, 200));
  setSessionCookie(res, token);
  res.json({ member: publicMember(member), isNew, needsProfile: !member.consent_at });
}));

// Who am I?
app.get('/api/me', h(async (req, res) => {
  if (!req.member) return res.status(401).json({ member: null });
  const sessions = (await store.listSessions(req.member.id)).map((s) => ({
    createdAt: s.created_at,
    lastSeen: s.last_seen,
    userAgent: s.user_agent,
    current: s.token_hash === req.sessionHash,
  }));
  res.json({ member: publicMember(req.member), sessions });
}));

// Save my details (first time after sign-in, and later edits).
// The contact used to sign in is verified and can't be changed here; the other one is optional
// for email and required for phone.
app.post('/api/me', h(async (req, res) => {
  const m = req.member;
  if (!m) return res.status(401).json({ error: 'Please log in.' });

  const firstTime = !m.consent_at;
  const { profile, errors = {} } = validateProfile(req.body, { requireConsent: firstTime });

  let phone = null, email = null;
  if (!m.phone_verified) {
    phone = normalizePhone(req.body.phone);
    if (!phone) errors.phone = 'Enter a valid Nigerian phone number, e.g. 0803 123 4567.';
  }
  if (!m.email_verified) {
    const raw = String(req.body.email || '').trim().toLowerCase();
    if (raw && !isEmail(raw)) errors.email = 'Enter a valid email address, or leave it blank.';
    else email = raw || null;
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });

  if (phone && phone !== m.phone && !(await store.setContact(m.id, 'phone', phone))) {
    return res.status(409).json({ error: 'Please fix the highlighted fields.', fields: { phone: 'This number is already registered to another member.' } });
  }
  if (!m.email_verified && email !== (m.email || null)) {
    if (email && !(await store.setContact(m.id, 'email', email))) {
      return res.status(409).json({ error: 'Please fix the highlighted fields.', fields: { email: 'This email is already registered to another member.' } });
    }
    if (!email) await store.setContact(m.id, 'email', null);
  }

  await store.updateProfile(m.id, profile, Date.now());
  res.json({ member: publicMember(await store.memberById(m.id)) });
}));

// Log out this device
app.post('/api/auth/logout', h(async (req, res) => {
  if (req.sessionHash) await store.deleteSession(req.sessionHash);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

// Log out every device
app.post('/api/auth/logout-all', h(async (req, res) => {
  if (req.member) await store.deleteMemberSessions(req.member.id);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

// One page handles both joining and logging in.
app.get(['/join', '/signup'], (req, res) => res.redirect(302, '/login'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

// Housekeeping: clear expired codes every 15 minutes.
setInterval(() => store.purgeCodes(Date.now()).catch(() => {}), 15 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Running at http://localhost:${PORT}  (db: ${store.kind}, email: ${mailer.provider || 'console (dev)'}, sms: ${sms.provider || (IS_PROD ? 'off' : 'console (dev)')})`);
});
