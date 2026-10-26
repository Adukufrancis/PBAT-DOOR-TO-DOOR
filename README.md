# PBAT DOOR TO DOOR

A volunteer website with:
- **Landing page** (`/`): the President's photos, a short bio timeline, and his administration's works, each linked to its source.
- **Join** (`/join`): full sign-up form (name, email, phone, gender, date of birth, state, LGA, ward, polling unit, address, occupation, areas to help, consent). A 6-digit code is emailed to confirm the address before the account is created.
- **Log in** (`/login`): enter your email, get a code, and you're in. No passwords.
- **My account** (`/account`): view and edit your details, see your logged-in devices, log out. You stay logged in until you log out yourself.

## Editing the content
- **His works:** edit the `WORKS` list near the bottom of `public/index.html`.
- **Photos:** add your own to `public/images/` (`hero.jpg`, `gallery-1.jpg` … `gallery-5.jpg`) and they replace the default Wikimedia Commons photos automatically. Only use photos you have the right to use.
- **Sign-up options** (states, help areas): `validate.js`.

## Run it locally

```bash
npm install
npm start                # http://localhost:3000
```

Needs Node.js 22.13 or newer. Locally you don't need any configuration. The code is printed in the terminal and shown on the page, and data goes into a local SQLite file. Copy `.env.example` to `.env` if you want to try real email or Postgres locally.

## Deploy on Render (free plan)

The Render free plan has two limits that affect this app, and the app handles both:

| Limit on Render free | What this app does instead |
|---|---|
| Outbound SMTP (ports 25/465/587) is blocked | Sends email through **Brevo's HTTPS API** (port 443) |
| The disk is wiped on every deploy/restart/spin-down | Stores users and sessions in **Postgres** (`DATABASE_URL`) |

### 1. Get a Postgres database
Use any Postgres provider and copy its connection string (`postgres://…`). Two options:
- **Neon** or **Supabase**: both have free plans.
- **Render Postgres**: easy to set up, but free Render databases expire after 30 days, so upgrade it or move off it before then.

The tables are created automatically on first start.

### 2. Set up Brevo for email
1. Create a free account at brevo.com. The free plan allows 300 emails per day.
2. Go to **Senders, Domains & Dedicated IPs** → **Senders** → add and verify the email address you'll send from (a Gmail address works).
3. Go to **SMTP & API** → **API Keys** → create a key (it starts with `xkeysib-`).

### 3. Create the service on Render
**Option A, Blueprint (fastest):** Dashboard → **New** → **Blueprint** → pick this repo. Render reads `render.yaml` and asks for the three secrets below.

**Option B, manual:** **New** → **Web Service** → pick this repo, then use:
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/healthz`
- Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |
| `DATABASE_URL` | your Postgres connection string |
| `BREVO_API_KEY` | your Brevo key |
| `MAIL_FROM` | `PBAT DOOR TO DOOR <the-email-you-verified@gmail.com>` |

After it deploys, open the `onrender.com` URL and sign in. The logs show `db: postgres, email: brevo` when everything is set up correctly.

> Free Render services go to sleep after a period of inactivity, so the first visit after a quiet spell can take up to a minute. Thanks to Postgres, everyone stays signed in through that.

## How it works

| Step | Endpoint | What happens |
|---|---|---|
| Join | `POST /api/auth/signup` | Validates the form, holds the details, and emails a 6-digit code (only its hash is stored, valid 10 minutes). |
| Log in | `POST /api/auth/request-code` | Emails a code to an existing member (or resends during sign-up). |
| Both | `POST /api/auth/verify-code` | Checks the code, deletes it so it can't be reused, creates the account if signing up, and starts a session. |
| — | `POST /api/me` | Updates your details. |
| — | `GET /api/options` | States, genders, and help areas for the form. |
| — | `GET /api/me` | Returns the signed-in user and their signed-in devices. |
| — | `POST /api/auth/logout` | Ends this device's session. |
| — | `POST /api/auth/logout-all` | Ends every session for the account. |
| — | `GET /healthz` | Health check for Render. |

### "Stay signed in until logout"
- Sessions are stored in the database with **no expiry**. Only logging out deletes them.
- The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Its lifetime is set to the browser maximum (about 400 days) and refreshed on visits, so active users are never logged out.
- The cookie holds a random 256-bit token, and the database stores only its hash.

### Security
- Codes expire after 10 minutes, work only once, and stop working after 5 wrong guesses.
- You can request one new code per email per minute.
- POST requests must be JSON, which together with SameSite cookies gives basic CSRF protection.
- In production, codes are never shown on the page.

### Email providers
The app uses the first provider that's configured: `BREVO_API_KEY` → `RESEND_API_KEY` (needs your own domain) → `SMTP_HOST` (only works on paid Render plans or other hosts) → console output (development only).

## Files
```
server.js          Express routes, sessions, cookies
validate.js        Sign-up form rules (phone, age 18+, states…)
store.js           Database layer: Postgres if DATABASE_URL is set, otherwise SQLite
mailer.js          Email sending: Brevo / Resend / SMTP / console
public/index.html  Landing page (photos, bio, works)
public/join.html   Sign-up
public/login.html  Log in
public/account.html  Member area
public/app.js, styles.css  Shared code and styles
public/images/     Your own photos (optional)
render.yaml        Render Blueprint
.env.example       Configuration template
```
