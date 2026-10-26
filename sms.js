// Sends the sign-in code by SMS. Picks the first provider that is configured:
//   1. Termii  (TERMII_API_KEY + TERMII_SENDER_ID)  — Nigerian provider, pay-as-you-go
//   2. Twilio  (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM)
//   3. none    — development: the code is printed to the console (and shown on screen).
//               In production, phone sign-in is switched off until a provider is set.
// Phone numbers arrive in the form +2348031234567.

export function createSms(env = process.env) {
  const appName = env.APP_NAME || 'PBAT DOOR TO DOOR';
  const text = (code) => `${code} is your ${appName} code. It expires in 10 minutes. Don't share it with anyone.`;

  if (env.TERMII_API_KEY && env.TERMII_SENDER_ID) {
    // Each Termii account has its own base URL (shown on the Termii dashboard), e.g. https://v3.api.termii.com
    let base = (env.TERMII_BASE_URL || 'https://api.ng.termii.com').trim().replace(/\/+$/, '').replace(/\/api$/, '');
    if (!/^https?:\/\//.test(base)) base = `https://${base}`;
    return {
      provider: 'termii',
      async send(phone, code) {
        const res = await fetch(`${base}/api/sms/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            api_key: env.TERMII_API_KEY,
            to: phone.replace(/^\+/, ''),          // Termii wants 2348031234567
            from: env.TERMII_SENDER_ID,
            sms: text(code),
            type: 'plain',
            channel: env.TERMII_CHANNEL || 'dnd',  // 'dnd' reaches numbers on Do-Not-Disturb
          }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await res.text().catch(() => '');
        if (!res.ok) throw new Error(`Termii ${res.status}: ${body}`.slice(0, 400));
        // Termii sometimes answers 200 with an error message instead of a message_id
        if (!/message_id|Successfully/i.test(body)) throw new Error(`Termii: ${body}`.slice(0, 400));
      },
    };
  }

  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    return {
      provider: 'twilio',
      async send(phone, code) {
        const form = new URLSearchParams({ To: phone, Body: text(code) });
        if (env.TWILIO_FROM.startsWith('MG')) form.set('MessagingServiceSid', env.TWILIO_FROM);
        else form.set('From', env.TWILIO_FROM);
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(15000),
        });
        const body = await res.text().catch(() => '');
        if (!res.ok) throw new Error(`Twilio ${res.status}: ${body}`.slice(0, 400));
      },
    };
  }

  return {
    provider: null,
    send: async (phone, code) => console.log(`\n[dev] SMS code for ${phone}: ${code}\n`),
  };
}
