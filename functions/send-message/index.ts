// RepairAbility: sends the message for a job assignment by email or text message.
// Called by the app when a Repair Agent is assigned to a job. The caller must be a signed-in,
// active person. Providers are configured with secrets (set only the ones you need):
//   Email (Resend):  RESEND_API_KEY, MAIL_FROM  (e.g. "RepairAbility <jobs@yourdomain.com>")
//   Text (Twilio):   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (number or sender name)
//   supabase functions deploy send-message        (JWT verification stays ON)
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// UK style numbers (07..., 0044..., 44...) -> E.164
const e164 = (raw: string) => {
  let n = raw.replace(/[\s().-]/g, '');
  if (n.startsWith('00')) n = '+' + n.slice(2);
  else if (n.startsWith('0')) n = '+44' + n.slice(1);
  else if (!n.startsWith('+')) n = '+' + n;
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: active, error: e1 } = await caller.rpc('ra_is_active');
  if (e1 || active !== true) return reply(403, { error: 'You must be signed in as an active person' });

  let b: { channel?: string; to?: string; subject?: string; body?: string };
  try { b = await req.json(); } catch { return reply(400, { error: 'The body must be valid JSON' }); }
  const to = String(b?.to || '').trim(), text = String(b?.body || ''), subject = String(b?.subject || '');
  if (!to || !text) return reply(400, { error: 'A recipient and a message are required' });
  if (text.length > 1600) return reply(400, { error: 'The message is too long' });

  if (b.channel === 'Email') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return reply(422, { error: 'The email address is not valid' });
    const key = Deno.env.get('RESEND_API_KEY'), from = Deno.env.get('MAIL_FROM');
    if (!key || !from) return reply(501, { error: 'Email sending has not been set up yet (RESEND_API_KEY and MAIL_FROM)' });
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: subject || 'New job', text }),
    });
    if (!r.ok) { console.error('resend', r.status, await r.text()); return reply(502, { error: 'The email provider refused the message' }); }
    return reply(200, { sent: true });
  }

  if (b.channel === 'Text Message') {
    const num = e164(to);
    if (!num) return reply(422, { error: 'The phone number is not valid' });
    const sid = Deno.env.get('TWILIO_ACCOUNT_SID'), tok = Deno.env.get('TWILIO_AUTH_TOKEN'), from = Deno.env.get('TWILIO_FROM');
    if (!sid || !tok || !from) return reply(501, { error: 'Text messaging has not been set up yet (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM)' });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(sid + ':' + tok), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: num, From: from, Body: text }),
    });
    if (!r.ok) { console.error('twilio', r.status, await r.text()); return reply(502, { error: 'The text message provider refused the message' }); }
    return reply(200, { sent: true });
  }
  return reply(400, { error: 'Unknown channel' });
});
