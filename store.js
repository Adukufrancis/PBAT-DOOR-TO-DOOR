// Data layer. Uses Postgres when DATABASE_URL is set (production, e.g. on Render),
// otherwise a local SQLite file (development). Both expose the same async API.
import path from 'node:path';

// Profile fields collected at sign-up (all stored as text).
export const PROFILE_FIELDS = [
  'full_name', 'phone', 'gender', 'date_of_birth', 'state', 'lga', 'ward',
  'polling_unit', 'address', 'occupation', 'interests',
];

const SCHEMA = (big, idDef) => `
  CREATE TABLE IF NOT EXISTS users (
    id            ${idDef},
    email         TEXT UNIQUE NOT NULL,
    full_name     TEXT NOT NULL DEFAULT '',
    phone         TEXT NOT NULL DEFAULT '',
    gender        TEXT NOT NULL DEFAULT '',
    date_of_birth TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL DEFAULT '',
    lga           TEXT NOT NULL DEFAULT '',
    ward          TEXT NOT NULL DEFAULT '',
    polling_unit  TEXT NOT NULL DEFAULT '',
    address       TEXT NOT NULL DEFAULT '',
    occupation    TEXT NOT NULL DEFAULT '',
    interests     TEXT NOT NULL DEFAULT '',
    consent_at    ${big},
    created_at    ${big} NOT NULL
  );
  CREATE TABLE IF NOT EXISTS login_codes (
    email       TEXT PRIMARY KEY,
    code_hash   TEXT NOT NULL,
    expires_at  ${big} NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    sent_at     ${big} NOT NULL,
    pending     TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  ${big} NOT NULL,
    last_seen   ${big} NOT NULL,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
`;

const USER_COLS = `id, email, ${PROFILE_FIELDS.join(', ')}, consent_at, created_at`;

// Every query is written once with $1, $2… placeholders.
const QUERIES = {
  getCode: 'SELECT * FROM login_codes WHERE email = $1',
  upsertCode: `INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at, pending)
               VALUES ($1, $2, $3, 0, $4, $5)
               ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash,
                 expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at,
                 pending = EXCLUDED.pending`,
  bumpAttempts: 'UPDATE login_codes SET attempts = attempts + 1 WHERE email = $1',
  deleteCode: 'DELETE FROM login_codes WHERE email = $1',
  purgeCodes: 'DELETE FROM login_codes WHERE expires_at < $1',
  insertUser: `INSERT INTO users (email, ${PROFILE_FIELDS.join(', ')}, consent_at, created_at)
               VALUES (${['$1', ...PROFILE_FIELDS.map((_, i) => `$${i + 2}`), `$${PROFILE_FIELDS.length + 2}`, `$${PROFILE_FIELDS.length + 3}`].join(', ')})
               ON CONFLICT (email) DO NOTHING`,
  updateUser: `UPDATE users SET ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1`,
  getUserByEmail: `SELECT ${USER_COLS} FROM users WHERE email = $1`,
  getUserById: `SELECT ${USER_COLS} FROM users WHERE id = $1`,
  insertSession: `INSERT INTO sessions (token_hash, user_id, created_at, last_seen, user_agent)
                  VALUES ($1, $2, $3, $4, $5)`,
  getSession: 'SELECT token_hash, user_id, last_seen FROM sessions WHERE token_hash = $1',
  touchSession: 'UPDATE sessions SET last_seen = $1 WHERE token_hash = $2',
  listSessions: `SELECT token_hash, created_at, last_seen, user_agent FROM sessions
                  WHERE user_id = $1 ORDER BY last_seen DESC`,
  deleteSession: 'DELETE FROM sessions WHERE token_hash = $1',
  deleteUserSessions: 'DELETE FROM sessions WHERE user_id = $1',
};

// Postgres returns BIGINT as strings; turn numeric columns back into numbers.
const NUMERIC = new Set(['id', 'user_id', 'created_at', 'expires_at', 'sent_at', 'last_seen', 'attempts', 'consent_at']);
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
  return {
    kind: raw.kind,
    close: raw.close,
    getCode: (email) => one('getCode', [email]),
    upsertCode: (email, hash, expiresAt, sentAt, pending = null) =>
      raw.q('upsertCode', [email, hash, expiresAt, sentAt, pending ? JSON.stringify(pending) : null]),
    bumpAttempts: (email) => raw.q('bumpAttempts', [email]),
    deleteCode: (email) => raw.q('deleteCode', [email]),
    purgeCodes: (now) => raw.q('purgeCodes', [now]),
    getUserByEmail: (email) => one('getUserByEmail', [email]),
    getUserById: (id) => one('getUserById', [id]),
    createUser: async (email, profile, now) => {
      await raw.q('insertUser', [email, ...PROFILE_FIELDS.map((f) => profile[f] ?? ''), now, now]);
      return one('getUserByEmail', [email]);
    },
    updateUser: (id, profile) => raw.q('updateUser', [id, ...PROFILE_FIELDS.map((f) => profile[f] ?? '')]),
    insertSession: (hash, userId, now, ua) => raw.q('insertSession', [hash, userId, now, now, ua]),
    getSession: (hash) => one('getSession', [hash]),
    touchSession: (hash, now) => raw.q('touchSession', [now, hash]),
    listSessions: (userId) => raw.q('listSessions', [userId]),
    deleteSession: (hash) => raw.q('deleteSession', [hash]),
    deleteUserSessions: (userId) => raw.q('deleteUserSessions', [userId]),
  };
}
