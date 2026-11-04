// RepairAbility: an administrator creates an account or sets a person's sign-in password.
// Called from the person form. The caller must be signed in as a SYSADMIN; the account
// is created already confirmed, so no email is sent.
//   supabase functions deploy set-user-password        (JWT verification stays ON)
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: isAdmin, error: e1 } = await caller.rpc('ra_is_admin');
  if (e1 || isAdmin !== true) return reply(403, { error: 'Only a system administrator can do this' });

  let body: { email?: string; password?: string };
  try { body = await req.json(); } catch { return reply(400, { error: 'The body must be valid JSON' }); }
  const email = String(body?.email || '').trim();
  const password = String(body?.password || '');

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc('ra_admin_set_password', { p_email: email, p_password: password });
  if (error) {
    if (error.code === 'RA422') return reply(422, { error: error.message });
    console.error('set-user-password failed', error);
    return reply(500, { error: 'The account could not be updated' });
  }
  return reply(200, data);
});
