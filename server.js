import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, PROFILE_FIELDS } from './store.js';
import { createMailer } from './mailer.js';
import { validateProfile, STATES, GENDERS, INTERESTS } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// ---- Tunables ---------------------------------------------------------------
const CODE_TTL_MS = 10 * 60 * 1000;          // a code is valid for 10 minutes
const CODE_MAX_ATTEMPTS = 5;                 // wrong guesses before the code is burned
const RESEND_COOLDOWN_MS = 60 * 1000;        // one new code per email per minute
const COOKIE_NAME = 'sid';
// Browsers cap cookie lifetime at ~400 days, so the cookie is refreshed on visits.
// The session itself never expires: only logging out ends it.
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

const store = await createStore();
const mailer = createMailer();

if (IS_PROD && store.kind !== 'postgres') {
  console.warn('WARNING: running in production without DATABASE_URL. On hosts with a temporary disk ' +
    '(like Render free), every restart will sign everyone out. Set DATABASE_URL to a Postgres database.');
}
if (IS_PROD && !mailer.provider) {
  console.warn('WARNING: no email provider configured (BREVO_API_KEY, RESEND_API_KEY or SMTP_HOST). ' +
    'Nobody will be able to receive sign-in codes.');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

const publicUser = (u) => {
  const out = { email: u.email, createdAt: u.created_at };
  for (const f of PROFILE_FIELDS) out[f] = u[f];
  out.interests = u.interests ? u.interests.split(', ') : [];
  return out;
};

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

// Loads the user from the session cookie (if any) and keeps the cookie fresh.
app.use(h(async (req, res, next) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return next();
  const s = await store.getSession(sha256(token));
  const user = s && (await store.getUserById(s.user_id));
  if (!user) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return next();
  }
  req.user = user;
  req.sessionHash = s.token_hash;
  // Refresh at most once an hour to avoid a write per request.
  if (Date.now() - s.last_seen > 60 * 60 * 1000) {
    await store.touchSession(s.token_hash, Date.now());
    setSessionCookie(res, token);
  }
  next();
}));

// Options for the sign-up form, so the browser and server use the same lists.
app.get('/api/options', (req, res) => res.json({ states: STATES, genders: GENDERS, interests: INTERESTS }));

// Shared: create a code for an email and send it. `pending` holds sign-up details until verified.
async function issueCode(res, email, pending = null) {
  const existing = await store.getCode(email);
  const now = Date.now();
  if (existing && now - existing.sent_at < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.sent_at)) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.`, retryAfter: wait });
  }
  // A resend during sign-up keeps the details the person already entered.
  if (!pending && existing?.pending) pending = JSON.parse(existing.pending);

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await store.upsertCode(email, sha256(`${email}:${code}`), now + CODE_TTL_MS, now, pending);

  try {
    await mailer.send(email, code);
  } catch (err) {
    console.error('Email send failed:', err.message);
    await store.deleteCode(email);
    return res.status(502).json({ error: "We couldn't send the email. Check the address and try again shortly." });
  }

  const body = { ok: true, cooldown: RESEND_COOLDOWN_MS / 1000 };
  // Without an email provider in development, hand the code to the UI so the flow can be tested.
  if (!mailer.provider && !IS_PROD) body.devCode = code;
  res.json(body);
}

// Sign up: full details -> code to the email
app.post('/api/auth/signup', h(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { profile, errors = {} } = validateProfile(req.body);
  if (!isEmail(email)) errors.email = 'Enter a valid email address.';
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });
  }
  if (await store.getUserByEmail(email)) {
    return res.status(409).json({ error: 'This email already has an account. Log in instead.', code: 'exists' });
  }
  return issueCode(res, email, { ...profile, consent_at: Date.now() });
}));

// Log in (or resend during sign-up): email -> code
app.post('/api/auth/request-code', h(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const user = await store.getUserByEmail(email);
  const pendingSignup = (await store.getCode(email))?.pending;
  if (!user && !pendingSignup) {
    return res.status(404).json({ error: "We couldn't find an account with that email. Join first.", code: 'no_account' });
  }
  return issueCode(res, email);
}));

// Confirm the code -> create account if signing up -> start a session
app.post('/api/auth/verify-code', h(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!isEmail(email) || code.length !== 6) {
    return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
  }

  const row = await store.getCode(email);
  if (!row || row.expires_at < Date.now()) {
    if (row) await store.deleteCode(email);
    return res.status(400).json({ error: 'That code has expired. Request a new one.', expired: true });
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await store.deleteCode(email);
    return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.', expired: true });
  }
  if (!safeEqual(sha256(`${email}:${code}`), row.code_hash)) {
    await store.bumpAttempts(email);
    const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
    return res.status(400).json({
      error: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Request a new code.',
      expired: left <= 0,
    });
  }

  // Code is good: single use.
  await store.deleteCode(email);

  const now = Date.now();
  let user = await store.getUserByEmail(email);
  let isNew = false;
  if (!user) {
    if (!row.pending) return res.status(404).json({ error: 'No account found. Please join first.', code: 'no_account' });
    user = await store.createUser(email, JSON.parse(row.pending), now);
    isNew = true;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await store.insertSession(sha256(token), user.id, now, String(req.get('user-agent') || '').slice(0, 200));
  setSessionCookie(res, token);
  res.json({ user: publicUser(user), isNew });
}));

// Who am I?
app.get('/api/me', h(async (req, res) => {
  if (!req.user) return res.status(401).json({ user: null });
  const sessions = (await store.listSessions(req.user.id)).map((s) => ({
    createdAt: s.created_at,
    lastSeen: s.last_seen,
    userAgent: s.user_agent,
    current: s.token_hash === req.sessionHash,
  }));
  res.json({ user: publicUser(req.user), sessions });
}));

// Update my details (email can't be changed here)
app.post('/api/me', h(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  const { profile, errors } = validateProfile(req.body, { requireConsent: false });
  if (errors) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });
  await store.updateUser(req.user.id, profile);
  res.json({ user: publicUser(await store.getUserById(req.user.id)) });
}));

// Log out this device
app.post('/api/auth/logout', h(async (req, res) => {
  if (req.sessionHash) await store.deleteSession(req.sessionHash);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

// Log out every device
app.post('/api/auth/logout-all', h(async (req, res) => {
  if (req.user) await store.deleteUserSessions(req.user.id);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

// Housekeeping: clear expired codes every 15 minutes.
setInterval(() => store.purgeCodes(Date.now()).catch(() => {}), 15 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Running at http://localhost:${PORT}  (db: ${store.kind}, email: ${mailer.provider || 'console (dev)'})`);
});
