// Data layer. Uses Postgres when DATABASE_URL is set (production, e.g. Neon on Render),
// otherwise a local SQLite file (development). Both expose the same async API.
//
// Members sign in with an email OR a phone number. A contact is "verified" once the
// person has entered a code sent to it; only verified contacts can be used to log in,
// and each verified email/phone belongs to at most one member.
import path from 'node:path';

// Profile questions asked after the first login (all stored as text).
export const PROFILE_FIELDS = [
  'full_name', 'gender', 'date_of_birth', 'state', 'lga', 'ward',
  'polling_unit', 'address', 'occupation', 'interests',
];

const SCHEMA = (big, idDef) => `
  CREATE TABLE IF NOT EXISTS members (
    id              ${idDef},
    email           TEXT,
    email_verified  INTEGER NOT NULL DEFAULT 0,
    phone           TEXT,
    phone_verified  INTEGER NOT NULL DEFAULT 0,
    full_name       TEXT NOT NULL DEFAULT '',
    gender          TEXT NOT NULL DEFAULT '',
    date_of_birth   TEXT NOT NULL DEFAULT '',
    state           TEXT NOT NULL DEFAULT '',
    lga             TEXT NOT NULL DEFAULT '',
    ward            TEXT NOT NULL DEFAULT '',
    polling_unit    TEXT NOT NULL DEFAULT '',
    address         TEXT NOT NULL DEFAULT '',
    occupation      TEXT NOT NULL DEFAULT '',
    interests       TEXT NOT NULL DEFAULT '',
    consent_at      ${big},
    created_at      ${big} NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS members_email_verified_uq ON members(email) WHERE email_verified = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS members_phone_verified_uq ON members(phone) WHERE phone_verified = 1;
  CREATE INDEX IF NOT EXISTS members_email_idx ON members(email);
  CREATE INDEX IF NOT EXISTS members_phone_idx ON members(phone);

  CREATE TABLE IF NOT EXISTS otp_codes (
    identifier  TEXT PRIMARY KEY,
    channel     TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  ${big} NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    sent_at     ${big} NOT NULL
  );

  CREATE TABLE IF NOT EXISTS member_sessions (
    token_hash  TEXT PRIMARY KEY,
    member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at  ${big} NOT NULL,
    last_seen   ${big} NOT NULL,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS member_sessions_member_idx ON member_sessions(member_id);
`;

const MEMBER_COLS = `id, email, email_verified, phone, phone_verified, ${PROFILE_FIELDS.join(', ')}, consent_at, created_at`;

// Every query is written once with $1, $2… placeholders.
const QUERIES = {
  getCode: 'SELECT * FROM otp_codes WHERE identifier = $1',
  upsertCode: `INSERT INTO otp_codes (identifier, channel, code_hash, expires_at, attempts, sent_at)
               VALUES ($1, $2, $3, $4, 0, $5)
               ON CONFLICT (identifier) DO UPDATE SET channel = EXCLUDED.channel, code_hash = EXCLUDED.code_hash,
                 expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at`,
  bumpAttempts: 'UPDATE otp_codes SET attempts = attempts + 1 WHERE identifier = $1',
  deleteCode: 'DELETE FROM otp_codes WHERE identifier = $1',
  purgeCodes: 'DELETE FROM otp_codes WHERE expires_at < $1',

  memberByVerifiedEmail: `SELECT ${MEMBER_COLS} FROM members WHERE email = $1 AND email_verified = 1`,
  memberByVerifiedPhone: `SELECT ${MEMBER_COLS} FROM members WHERE phone = $1 AND phone_verified = 1`,
  memberById: `SELECT ${MEMBER_COLS} FROM members WHERE id = $1`,
  // When someone proves they own a contact, remove it from any account that only typed it in.
  releaseUnverifiedEmail: 'UPDATE members SET email = NULL WHERE email = $1 AND email_verified = 0',
  releaseUnverifiedPhone: 'UPDATE members SET phone = NULL WHERE phone = $1 AND phone_verified = 0',
  insertByEmail: 'INSERT INTO members (email, email_verified, created_at) VALUES ($1, 1, $2)',
  insertByPhone: 'INSERT INTO members (phone, phone_verified, created_at) VALUES ($1, 1, $2)',
  verifyEmail: 'UPDATE members SET email_verified = 1 WHERE id = $1 AND email = $2',
  verifyPhone: 'UPDATE members SET phone_verified = 1 WHERE id = $1 AND phone = $2',
  setEmail: 'UPDATE members SET email = $2, email_verified = 0 WHERE id = $1 AND email_verified = 0',
  setPhone: 'UPDATE members SET phone = $2, phone_verified = 0 WHERE id = $1 AND phone_verified = 0',
  updateProfile: `UPDATE members SET ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')},
                    consent_at = COALESCE(consent_at, $${PROFILE_FIELDS.length + 2}) WHERE id = $1`,

  insertSession: `INSERT INTO member_sessions (token_hash, member_id, created_at, last_seen, user_agent)
                  VALUES ($1, $2, $3, $4, $5)`,
  getSession: 'SELECT token_hash, member_id, last_seen FROM member_sessions WHERE token_hash = $1',
  touchSession: 'UPDATE member_sessions SET last_seen = $1 WHERE token_hash = $2',
  listSessions: `SELECT token_hash, created_at, last_seen, user_agent FROM member_sessions
                  WHERE member_id = $1 ORDER BY last_seen DESC`,
  deleteSession: 'DELETE FROM member_sessions WHERE token_hash = $1',
  deleteMemberSessions: 'DELETE FROM member_sessions WHERE member_id = $1',
};

// Postgres returns BIGINT as strings; turn numeric columns back into numbers.
const NUMERIC = new Set(['id', 'member_id', 'created_at', 'expires_at', 'sent_at', 'last_seen', 'attempts',
  'consent_at', 'email_verified', 'phone_verified']);
const fixRow = (r) => {
  if (!r) return r;
  for (const k of Object.keys(r)) if (NUMERIC.has(k) && r[k] != null) r[k] = Number(r[k]);
  return r;
};

async function createPostgres(url) {
  const { default: pg } = await import('pg');
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await pool.query(SCHEMA('BIGINT', 'SERIAL PRIMARY KEY'));
  const q = async (name, params = []) => (await pool.query(QUERIES[name], params)).rows.map(fixRow);
  return { kind: 'postgres', q, close: () => pool.end() };
}

async function createSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA('INTEGER', 'INTEGER PRIMARY KEY AUTOINCREMENT'));
  const stmts = {};
  const q = async (name, params = []) => {
    const sql = QUERIES[name].replace(/\$(\d+)/g, '?$1');
    const stmt = (stmts[name] ??= db.prepare(sql));
    return /^\s*SELECT/i.test(sql) ? stmt.all(...params).map((r) => ({ ...r })) : (stmt.run(...params), []);
  };
  return { kind: 'sqlite', q, close: () => db.close() };
}

export async function createStore() {
  const raw = process.env.DATABASE_URL ? await createPostgres(process.env.DATABASE_URL)
    : await createSqlite(process.env.DB_PATH || path.join(process.cwd(), 'data.db'));
  const one = async (name, params) => (await raw.q(name, params))[0];
  const byVerified = (type, value) => one(type === 'email' ? 'memberByVerifiedEmail' : 'memberByVerifiedPhone', [value]);

  return {
    kind: raw.kind,
    close: raw.close,

    getCode: (id) => one('getCode', [id]),
    upsertCode: (id, channel, hash, expiresAt, sentAt) => raw.q('upsertCode', [id, channel, hash, expiresAt, sentAt]),
    bumpAttempts: (id) => raw.q('bumpAttempts', [id]),
    deleteCode: (id) => raw.q('deleteCode', [id]),
    purgeCodes: (now) => raw.q('purgeCodes', [now]),

    memberById: (id) => one('memberById', [id]),
    memberByVerified: byVerified,

    /** The person proved they own this email/phone: return their member, creating one if new. */
    async signInWith(type, value, now) {
      const existing = await byVerified(type, value);
      if (existing) return { member: existing, isNew: false };
      await raw.q(type === 'email' ? 'releaseUnverifiedEmail' : 'releaseUnverifiedPhone', [value]);
      try {
        await raw.q(type === 'email' ? 'insertByEmail' : 'insertByPhone', [value, now]);
      } catch (err) {
        // Two sign-ins racing for the same new contact: the other one won, use it.
        const winner = await byVerified(type, value);
        if (winner) return { member: winner, isNew: false };
        throw err;
      }
      return { member: await byVerified(type, value), isNew: true };
    },

    /** Store a contact the member typed in (not verified yet). Returns false if someone else has it verified. */
    async setContact(memberId, type, value) {
      const owner = await byVerified(type, value);
      if (owner && owner.id !== memberId) return false;
      if (owner && owner.id === memberId) return true;
      await raw.q(type === 'email' ? 'setEmail' : 'setPhone', [memberId, value]);
      return true;
    },

    updateProfile: (id, profile, now) =>
      raw.q('updateProfile', [id, ...PROFILE_FIELDS.map((f) => profile[f] ?? ''), now]),

    insertSession: (hash, memberId, now, ua) => raw.q('insertSession', [hash, memberId, now, now, ua]),
    getSession: (hash) => one('getSession', [hash]),
    touchSession: (hash, now) => raw.q('touchSession', [now, hash]),
    listSessions: (memberId) => raw.q('listSessions', [memberId]),
    deleteSession: (hash) => raw.q('deleteSession', [hash]),
    deleteMemberSessions: (memberId) => raw.q('deleteMemberSessions', [memberId]),
  };
}
