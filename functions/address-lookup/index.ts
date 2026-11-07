// RepairAbility: finds the addresses at a UK postcode so the app can fill in address fields.
// The caller must be a signed-in, active person.
//   With the secret GETADDRESS_API_KEY set (getAddress.io), returns the full list of addresses.
//   Without it, falls back to the free postcodes.io service, which only knows the town and county.
//   supabase functions deploy address-lookup        (JWT verification stays ON)
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const tidy = (s: unknown) => String(s ?? '').trim();

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: active, error: e1 } = await caller.rpc('ra_is_active');
  if (e1 || active !== true) return reply(403, { error: 'You must be signed in as an active person' });

  let b: { postcode?: string };
  try { b = await req.json(); } catch { return reply(400, { error: 'The body must be valid JSON' }); }
  const raw = tidy(b?.postcode).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(raw)) return reply(422, { error: 'Enter a full UK postcode, for example LE2 3HQ' });
  const postcode = raw.slice(0, -3) + ' ' + raw.slice(-3);

  const key = Deno.env.get('GETADDRESS_API_KEY');
  if (key) {
    const r = await fetch(`https://api.getAddress.io/find/${encodeURIComponent(raw)}?expand=true&api-key=${encodeURIComponent(key)}`);
    if (r.status === 404) return reply(404, { error: 'No addresses were found for that postcode' });
    if (r.status === 429) return reply(429, { error: 'The daily address lookup limit has been reached' });
    if (!r.ok) { console.error('getaddress', r.status, await r.text()); return reply(502, { error: 'The address lookup service refused the request' }); }
    const j = await r.json();
    const addresses = (j.addresses || []).map((a: Record<string, string>) => ({
      line1: tidy(a.line_1),
      line2: [a.line_2, a.line_3, a.line_4, a.locality].map(tidy).filter(Boolean).join(', '),
      town: tidy(a.town_or_city),
      county: tidy(a.county),
      postcode,
    }));
    return reply(200, { source: 'full', addresses });
  }

  const r = await fetch(`https://api.postcodes.io/postcodes/${raw}`);
  if (r.status === 404) return reply(404, { error: 'That postcode was not found' });
  if (!r.ok) { console.error('postcodes.io', r.status); return reply(502, { error: 'The postcode service could not be reached' }); }
  const x = (await r.json()).result || {};
  return reply(200, {
    source: 'area',
    addresses: [{ line1: '', line2: '', town: tidy(x.parish || x.admin_district), county: tidy(x.admin_county || x.region), postcode }],
  });
});
