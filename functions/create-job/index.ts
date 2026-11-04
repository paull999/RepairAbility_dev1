// RepairAbility: create a job from an outside system.
// POST with header  x-api-key: <key>  and a JSON body. Authentication is the API key
// (checked in the database), so Supabase's own JWT check is switched off for this function:
//   supabase functions deploy create-job --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-api-key, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const key = req.headers.get('x-api-key') || bearer;
  if (!key) return reply(401, { error: 'Missing API key. Send it in the x-api-key header.' });

  let body: unknown;
  try { body = await req.json(); } catch { return reply(400, { error: 'The body must be valid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'The body must be a JSON object' });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.rpc('ra_api_create_job', { p: body, p_key: key });
  if (error) {
    if (error.code === 'RA401') return reply(401, { error: 'Invalid or missing API key' });
    if (error.code === 'RA422') return reply(422, { error: error.message });
    console.error('create-job failed', error);
    return reply(500, { error: 'The job could not be created' });
  }
  const d = data as { id: string; number: number; duplicate: boolean };
  return reply(d.duplicate ? 200 : 201, { id: d.id, number: d.number, duplicate: d.duplicate });
});
