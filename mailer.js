// Sends the sign-in code. Picks the first provider that is configured:
//   1. Brevo HTTP API  (BREVO_API_KEY)  — works on Render's free tier, no domain needed
//   2. Resend HTTP API (RESEND_API_KEY) — works on Render's free tier, needs a verified domain
//   3. SMTP            (SMTP_HOST)      — blocked on Render's free tier; fine on paid instances
//   4. none            — development only: the code is printed to the console
import nodemailer from 'nodemailer';

function parseFrom(value) {
  // Accepts "Name <email@x.com>" or "email@x.com"
  const m = String(value || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: String(value || '').trim() };
}

function render(appName, code) {
  return {
    subject: `${code} is your ${appName} sign-in code`,
    text: `Your ${appName} sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for this, you can ignore this email.`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px">
        <p style="color:#555">Your ${appName} sign-in code is</p>
        <p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:8px 0 16px">${code}</p>
        <p style="color:#777;font-size:14px">It expires in 10 minutes. If you didn't ask for this, you can ignore this email.</p>
      </div>`,
  };
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text().catch(() => '')}`.slice(0, 500));
}

export function createMailer(env = process.env) {
  const appName = env.APP_NAME || 'PBAT DOOR TO DOOR';
  const from = parseFrom(env.MAIL_FROM || env.SMTP_USER);

  if (env.BREVO_API_KEY) {
    return {
      provider: 'brevo',
      send: (to, code) => {
        const m = render(appName, code);
        return postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': env.BREVO_API_KEY }, {
          sender: { email: from.email, name: from.name || appName },
          to: [{ email: to }],
          subject: m.subject, textContent: m.text, htmlContent: m.html,
        });
      },
    };
  }

  if (env.RESEND_API_KEY) {
    return {
      provider: 'resend',
      send: (to, code) => {
        const m = render(appName, code);
        return postJson('https://api.resend.com/emails', { Authorization: `Bearer ${env.RESEND_API_KEY}` }, {
          from: from.name ? `${from.name} <${from.email}>` : from.email,
          to: [to], subject: m.subject, text: m.text, html: m.html,
        });
      },
    };
  }

  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT || 587);
    const t = nodemailer.createTransport({
      host: env.SMTP_HOST, port, secure: port === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
    return {
      provider: 'smtp',
      send: (to, code) => {
        const m = render(appName, code);
        return t.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, ...m });
      },
    };
  }

  return {
    provider: null,
    send: async (to, code) => console.log(`\n[dev] Login code for ${to}: ${code}\n`),
  };
}
