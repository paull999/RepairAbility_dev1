// RepairAbility: GetBookings and ConfirmBooking for outside systems.
// This ONE file is deployed twice, as two functions that behave differently by their name:
//   supabase functions deploy get-bookings     --no-verify-jwt
//   supabase functions deploy confirm-booking  --no-verify-jwt
// (supabase/functions/confirm-booking/index.ts is an identical copy.)
//
// get-bookings    POST {"job": "<id>" | "jobNumber": 1560, "servicer"?: "<org id>"}
//                 Returns the servicers who can do the job and a list of booking options, worked out the same
//                 way as the Book button on a job. Every option carries its own unique key.
// confirm-booking POST {"key": "bk_..."}  Books the job using an option returned by get-bookings.
//
// Both authenticate with the same API key as create-job (header x-api-key).
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-api-key, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
class Http extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ---- dates: the app works in UK time ------------------------------------------------------------
const TODAY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const isoAdd = (iso: string, n: number) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();
const DAYF = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// deno-lint-ignore no-explicit-any
type R = Record<string, any>;

// ---- the app's rules, ported from the Book button -------------------------------------------------
const orgInsured = (o: R, today: string) => (o.insurance || []).some((c: R) => c.from && c.to && c.from <= today && c.to >= today);
const skillOK = (o: R, jt: R | undefined, today: string) => ((jt && jt.skills) || []).every((sk: string) =>
  (o.skills || []).includes(sk) && (() => {
    const cs = (o.certs || []).filter((c: R) => c.skill === sk);
    return !cs.length || cs.some((c: R) => (!c.from || c.from <= today) && (!c.to || c.to >= today));
  })());
const pcOut = (v: string) => { const t = String(v || '').toUpperCase().replace(/\s+/g, ''); return t.length >= 5 ? t.slice(0, -3) : t; };
const pcParse = (v: string) => {
  const m = /^([A-Z]{1,2})(?:(\d{1,2})([A-Z]?))?$/.exec(String(v || '').toUpperCase().replace(/\s+/g, ''));
  return m ? { a: m[1], n: m[2] == null ? null : +m[2], k: m[2] == null ? 0 : +m[2] * 100 + (m[3] ? m[3].charCodeAt(0) - 64 : 0) } : null;
};
const pcCovers = (rs: R[], d: string) => {
  const p = pcParse(d); if (!p) return false;
  return rs.some((r) => {
    const f = pcParse(r.from); if (!f || f.a !== p.a) return false;
    if (f.n == null) return true;
    if (!(r.to || '').trim()) return p.k === f.k;
    const t = pcParse(r.to); if (!t || t.n == null || t.a !== f.a) return false;
    return p.k >= f.k && p.k <= t.n * 100 + (t.k % 100 ? t.k % 100 : 99);
  });
};
const orgCovers = (o: R, pc: string) => { if (!pcParse(pcOut(pc))) return false; return pcCovers(o.pcRanges || [], pcOut(pc)); };
const bwLabel = (w: R) => w.description + ' (' + w.start + '–' + w.end + ')';
const isWorkDay = (o: R, d: string) => {
  const wd = o.workDays && o.workDays.length ? o.workDays : [0, 1, 2, 3, 4, 5, 6];
  return wd.includes(dow(d)) && !(o.unavail || []).some((x: R) => d >= x.from && d <= x.to);
};
const earliestBook = (o: R, n: number, today: string) => { let d = today, c = 0; for (let i = 0; i < 400 && c < n; i++) { d = isoAdd(d, 1); if (isWorkDay(o, d)) c++; } return d; };
// A message when the servicer cannot take the day, or '' when they can.
const dayInfo = (o: R, d: string, today: string): string => {
  if (!o || !d) return '';
  if (d < today) return 'That date has already passed';
  const ld = Math.max(0, Math.min(7, +o.leadDays || 0));
  if (ld && d < earliestBook(o, ld, today)) return o.name + ' needs at least ' + ld + ' working day' + (ld > 1 ? 's' : '') + ' notice';
  if (o.workDays && o.workDays.length && !o.workDays.includes(dow(d))) return o.name + ' does not work on ' + DAYF[dow(d)] + 's';
  const u = (o.unavail || []).find((x: R) => d >= x.from && d <= x.to);
  return u ? o.name + ' is unavailable on ' + d + (u.note ? ' (' + u.note + ')' : '') : '';
};
// Coverage supplement, as calculated when a servicer is set on a job.
const covMatch = (o: R, pc: string) => {
  const d = pcOut(pc); if (!o || !pcParse(d)) return null;
  const m = (o.pcRanges || []).filter((r: R) => pcCovers([r], d)).map((r: R) => ({ r, spec: pcParse(r.from)!.n == null ? 0 : 1, amt: Math.round((parseFloat(r.supp) || 0) * 100) / 100 }));
  m.sort((a: R, b: R) => b.spec - a.spec || b.amt - a.amt);
  return m.length ? m[0] : null;
};
const covLabel = (r: R) => r.to ? r.from + '–' + r.to : r.from;
const calcCov = (o: R, sys: R, pc: string) => {
  const P = (pc || '').toUpperCase().trim();
  if (o.covOverride) {
    const m = covMatch(o, pc);
    if (!m) return { covSupp: 0, covSrc: o.name + ' · postcode ' + P + ' is not in a coverage area' };
    return { covSupp: m.amt, covSrc: o.name + ' (organisation override) · coverage ' + covLabel(m.r) + ' · postcode ' + P };
  }
  const m = covMatch(sys, pc);
  if (!m) return { covSupp: 0, covSrc: 'System coverage supplements · no supplement for postcode ' + P };
  return { covSupp: m.amt, covSrc: 'System coverage supplement ' + covLabel(m.r) + ' · postcode ' + P };
};
const agFind = (org: R | undefined, jt: string, date: string, today: string) => {
  if (!org || !jt) return null;
  const d = date || today;
  return (org.agreedPrices || []).filter((a: R) => a.jobType === jt && a.start <= d && d <= a.end)
    .sort((x: R, y: R) => (y.start || '').localeCompare(x.start || ''))[0] || null;
};

// ---- data -------------------------------------------------------------------------------------------
const sb = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
async function coll(c: ReturnType<typeof sb>, name: string): Promise<R[]> {
  const out: R[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.from('docs').select('data').eq('coll', name).range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []).map((x: R) => x.data));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function authenticate(c: ReturnType<typeof sb>, req: Request) {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const key = req.headers.get('x-api-key') || bearer;
  if (!key) throw new Http(401, 'Missing API key. Send it in the x-api-key header.');
  const { data, error } = await c.rpc('ra_api_check_key', { p_key: key });
  if (error) throw error;
  if (!data) throw new Http(401, 'Invalid or missing API key');
}

type Option = { servicer: R; mode: string; date: string; window: string; load: number };
// Everything the Book button needs for one job.
async function bookingData(c: ReturnType<typeof sb>, job: R, today: string) {
  const [orgs, jobTypes, defWindows, jobs, sysCov] = await Promise.all([
    coll(c, 'orgs'), coll(c, 'jobTypes'), coll(c, 'bookingWindows'), coll(c, 'jobs'), coll(c, 'sysCov')]);
  const jt = jobTypes.find((t) => t.id === job.jobType);
  const org = orgs.find((o) => o.id === job.org);
  const pc = job.postcode || '';
  const cur = job.sorg || '';
  const canDo = (o: R) => orgInsured(o, today) && skillOK(o, jt, today) && orgCovers(o, pc);
  const windows = (o: R) => [...(o.useDefaultWindows !== false ? defWindows : (o.bookingWindows || []))]
    .sort((x, y) => (x.start || '').localeCompare(y.start || ''));
  const load = (o: R, d: string) => jobs.filter((j) => j.sorg === o.id && j.date === d && j.id !== job.id && !['Cancelled', 'Closed', 'Invoiced'].includes(j.status)).length;
  const servicers = orgs.filter((o) => o.orgType === 'Servicer' && o.status !== 'Inactive' && canDo(o)).sort((a, b) => a.name.localeCompare(b.name));
  const options: Option[] = [];
  servicers.forEach((o) => {
    const mode = o.bookTo || 'Book to a booking window';
    const wl = mode === 'Book to a booking window' ? windows(o).map(bwLabel) : [];
    if (mode === 'Assign only') { options.push({ servicer: o, mode, date: '', window: '', load: 0 }); return; }
    let n = 0;
    for (let i = 0; i < 120 && n < 5; i++) {
      const d = isoAdd(today, i); if (dayInfo(o, d, today)) continue; n++;
      const l = load(o, d);
      if (!wl.length) options.push({ servicer: o, mode, date: d, window: '', load: l });
      else wl.forEach((w) => options.push({ servicer: o, mode, date: d, window: w, load: l }));
    }
  });
  options.sort((a, b) => (a.date || '9').localeCompare(b.date || '9') || a.servicer.name.localeCompare(b.servicer.name));
  const first = (o: R) => { if ((o.bookTo || '') === 'Assign only') return ''; for (let i = 0; i < 120; i++) { const d = isoAdd(today, i); if (!dayInfo(o, d, today)) return d; } return null; };
  return { jt, org, servicers, options: options.slice(0, 60), first, sysCov: sysCov.find((x) => x.id === 'sys') || { pcRanges: [] }, orgs };
}
function checkJob(job: R | undefined, data: { org?: R }, today: string) {
  if (!job) throw new Http(404, 'No job matches');
  if (['Cancelled', 'Closed', 'Invoiced'].includes(job.status)) throw new Http(422, 'This job is ' + job.status + ' and cannot be booked');
  if (!agFind(data.org, job.jobType, job.date || '', today))
    throw new Http(422, 'No agreed price has been found for ' + (data.org ? data.org.name : 'this organisation') + ' and this job type, so the job cannot be booked');
}
async function findJob(c: ReturnType<typeof sb>, body: R): Promise<R | undefined> {
  if (body.job) { const { data } = await c.from('docs').select('data').eq('coll', 'jobs').eq('id', String(body.job)).limit(1); return data && data[0] ? data[0].data : undefined; }
  if (body.jobNumber != null && body.jobNumber !== '') {
    const { data } = await c.from('docs').select('data').eq('coll', 'jobs').eq('data->>number', String(body.jobNumber)).limit(1);
    return data && data[0] ? data[0].data : undefined;
  }
  throw new Http(422, 'job (job id) or jobNumber is required');
}
const rand = () => 'bk_' + [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('');
const HOURS = 24;

// ---- get-bookings -------------------------------------------------------------------------------------
async function getBookings(c: ReturnType<typeof sb>, body: R) {
  const today = TODAY();
  const job = await findJob(c, body);
  const d = job ? await bookingData(c, job, today) : { org: undefined } as R;
  checkJob(job, d, today);
  const want = String(body.servicer || '');
  if (want && !d.servicers.some((o: R) => o.id === want)) throw new Http(422, 'That servicer cannot do this job');
  const opts: Option[] = d.options.filter((o: Option) => !want || o.servicer.id === want);
  await c.from('ra_booking_options').delete().eq('job_id', job!.id);
  const expires = new Date(Date.now() + HOURS * 3600e3);
  const rows = opts.map((o) => ({ key: rand(), job_id: job!.id, sorg: o.servicer.id, book_date: o.date, book_window: o.window, expires_at: expires.toISOString() }));
  if (rows.length) { const { error } = await c.from('ra_booking_options').insert(rows); if (error) throw error; }
  return {
    job: { id: job!.id, number: job!.number, title: job!.title, status: job!.status, postcode: job!.postcode, jobType: (d.jt || {}).name || '', servicer: job!.sorg || '', date: job!.date || '', bookingWindow: job!.bookingWindow || '' },
    servicers: d.servicers.filter((o: R) => !want || o.id === want).map((o: R) => ({ id: o.id, name: o.name, bookTo: o.bookTo || 'Book to a booking window', phone: o.phone || '', email: o.email || '', earliestDate: d.first(o) })),
    bookings: opts.map((o, i) => ({
      key: rows[i].key, servicerId: o.servicer.id, servicer: o.servicer.name, bookTo: o.mode,
      date: o.date || null, bookingWindow: o.window || null, alreadyBooked: o.date ? o.load : null,
    })),
    expiresAt: expires.toISOString(),
  };
}

// ---- confirm-booking ----------------------------------------------------------------------------------
async function confirmBooking(c: ReturnType<typeof sb>, body: R) {
  const key = String(body.key || '').trim();
  if (!key) throw new Http(422, 'key is required');
  const { data: rows, error } = await c.from('ra_booking_options').select('*').eq('key', key).limit(1);
  if (error) throw error;
  const opt = rows && rows[0];
  if (!opt) throw new Http(404, 'That booking key is not recognised, or has already been used');
  if (new Date(opt.expires_at).getTime() < Date.now()) throw new Http(410, 'That booking key has expired. Call get-bookings again');
  const { data: jr } = await c.from('docs').select('data').eq('coll', 'jobs').eq('id', opt.job_id).limit(1);
  const job: R | undefined = jr && jr[0] ? jr[0].data : undefined;
  const today = TODAY();
  const d = job ? await bookingData(c, job, today) : { org: undefined } as R;
  checkJob(job, d, today);
  // The option must still be one the Book button would offer (the diary may have changed since).
  const o: R | undefined = d.servicers.find((s: R) => s.id === opt.sorg);
  if (!o) throw new Http(409, 'That servicer can no longer take this job. Call get-bookings again');
  const mode = o.bookTo || 'Book to a booking window';
  if (mode !== 'Assign only') {
    const why = dayInfo(o, opt.book_date, today);
    if (why) throw new Http(409, why + '. Call get-bookings again');
  }
  const patch: R = { sorg: o.id, status: 'Booked' };
  const users = await coll(c, 'users');
  const ag = users.find((u) => u.id === job!.agent);
  patch.agent = ag && ag.org === o.id ? job!.agent : '';
  patch.date = mode === 'Assign only' ? '' : opt.book_date;
  patch.bookingWindow = mode === 'Book to a booking window' ? opt.book_window : '';
  Object.assign(patch, calcCov(o, d.sysCov, job!.postcode || ''));
  const next = { ...job, ...patch };
  const { error: ue } = await c.from('docs').update({ data: next }).eq('path', 'jobs/' + job!.id);
  if (ue) throw ue;
  await c.from('ra_booking_options').delete().eq('job_id', job!.id);
  return {
    job: { id: job!.id, number: job!.number, status: 'Booked' },
    booking: { servicerId: o.id, servicer: o.name, date: patch.date || null, bookingWindow: patch.bookingWindow || null },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const confirm = path.endsWith('confirm-booking');
  try {
    const c = sb();
    await authenticate(c, req);
    let body: unknown;
    try { body = await req.json(); } catch { return reply(400, { error: 'The body must be valid JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'The body must be a JSON object' });
    return reply(200, confirm ? await confirmBooking(c, body as R) : await getBookings(c, body as R));
  } catch (e) {
    if (e instanceof Http) return reply(e.status, { error: e.message });
    console.error('booking api failed', e);
    return reply(500, { error: 'The request could not be completed' });
  }
});
