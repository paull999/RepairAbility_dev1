-- RepairAbility on Supabase: database schema, sign-up rules and row-level security.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again; it replaces the functions and policies.

create extension if not exists pgcrypto;

-- One table holds every record (jobs, users, orgs, ...) as a JSON document.
create table if not exists public.docs (
  path        text primary key,            -- 'jobs/abc123'
  coll        text not null,               -- 'jobs', 'users', 'orgs', 'blobs', 'meta' ...
  id          text not null,               -- 'abc123'
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid()
);
create index if not exists docs_coll_idx on public.docs (coll);
create index if not exists docs_users_email_idx on public.docs (lower(data->>'email')) where coll = 'users';
create index if not exists docs_jobs_agent_idx on public.docs ((data->>'agent')) where coll = 'jobs';

create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.docs_touch();

-- ---------------------------------------------------------------------------
-- Who is the signed-in person? Looked up from the 'users' records by email.
-- SECURITY DEFINER so the lookup itself is not blocked by row-level security.
-- ---------------------------------------------------------------------------
create or replace function public.ra_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select data from public.docs
  where coll = 'users'
    and lower(data->>'email') = lower(coalesce(auth.jwt()->>'email',''))
    and data->>'status' = 'Active'
  limit 1
$$;
create or replace function public.ra_is_active() returns boolean language sql stable as $$ select public.ra_me() is not null $$;
create or replace function public.ra_is_admin()  returns boolean language sql stable as $$ select coalesce(public.ra_me()->>'role' = 'SYSADMIN', false) $$;
create or replace function public.ra_is_agent()  returns boolean language sql stable as $$ select coalesce(public.ra_me()->>'personType' = 'Repair Agent', false) $$;
create or replace function public.ra_my_org()    returns text    language sql stable as $$ select public.ra_me()->>'org' $$;
create or replace function public.ra_is_sysuser() returns boolean language sql stable as $$ select coalesce(public.ra_me()->>'personType' = 'System User' and public.ra_me()->>'role' <> 'SYSADMIN', false) $$;
create or replace function public.ra_my_id()     returns text    language sql stable as $$ select public.ra_me()->>'id' $$;
revoke all on function public.ra_me() from public, anon;
grant execute on function public.ra_me(), public.ra_is_active(), public.ra_is_admin(), public.ra_is_agent(), public.ra_my_id(), public.ra_my_org(), public.ra_is_sysuser() to authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up rules. The first account ever created becomes the SYSADMIN.
-- Everyone after that can only create an account if an administrator has
-- already added a person with that email address.
-- ---------------------------------------------------------------------------
create or replace function public.ra_before_signup() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare em text := lower(coalesce(new.email,'')); has_admin boolean; nm text;
begin
  perform pg_advisory_xact_lock(7770001);
  select exists (select 1 from public.docs where coll = 'users' and data->>'role' = 'SYSADMIN') into has_admin;
  nm := coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(em,'@',1));
  if not has_admin then
    if exists (select 1 from public.docs where coll = 'users' and lower(data->>'email') = em) then
      update public.docs set data = data || '{"role":"SYSADMIN","status":"Active"}'::jsonb
        where coll = 'users' and lower(data->>'email') = em;
    else
      insert into public.docs (path, coll, id, data)
      select 'users/'||x, 'users', x, jsonb_build_object('id', x, 'name', nm, 'email', em, 'phone', '',
             'role','SYSADMIN','status','Active','org','','personType','System User')
      from (select 'u'||substr(encode(gen_random_bytes(8),'hex'),1,10) as x) s;
    end if;
  elsif not exists (select 1 from public.docs where coll = 'users' and lower(data->>'email') = em and data->>'status' = 'Active') then
    raise exception 'No active person with the email address % has been set up. Ask an administrator to add you first.', em using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists ra_before_signup on auth.users;
create trigger ra_before_signup before insert on auth.users
  for each row execute function public.ra_before_signup();

-- ---------------------------------------------------------------------------
-- Row-level security
--   SYSADMIN : everything.
--   Service agent : sees and updates only jobs assigned to them; cannot change
--                   the locked job fields, the assignment or the organisation.
--   System users : see only jobs of their own organisation (none if no organisation).
--   Other people : read everything except as below; create and edit jobs; cannot
--                  delete jobs, change the organisation of a job, or touch
--                  people / organisations / setup data.
-- ---------------------------------------------------------------------------
create or replace function public.ra_job_visible(j jsonb) returns boolean language sql stable as $$
  select case when public.ra_is_admin() then true
              when public.ra_is_agent() then j->>'agent' = public.ra_my_id()
              when public.ra_is_sysuser() then coalesce(public.ra_my_org(),'') <> '' and j->>'org' = public.ra_my_org()
              else public.ra_is_active() end $$;
grant execute on function public.ra_job_visible(jsonb) to authenticated;

alter table public.docs enable row level security;
alter table public.docs force row level security;
revoke all on public.docs from anon;
grant select, insert, update, delete on public.docs to authenticated;

drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated using (
  public.ra_is_admin()
  or (public.ra_is_active() and (coll <> 'jobs' or public.ra_job_visible(data)))
);

drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated with check (
  public.ra_is_admin()
  or (public.ra_is_active() and (
        coll in ('blobs','meta')
        or (coll = 'jobs' and not public.ra_is_agent() and public.ra_job_visible(data))))
);

drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
using (
  public.ra_is_admin()
  or (public.ra_is_active() and (
        coll in ('blobs','meta')
        or (coll = 'jobs' and public.ra_job_visible(data))))
)
with check (
  public.ra_is_admin()
  or (public.ra_is_active() and (
        coll in ('blobs','meta')
        or (coll = 'jobs' and public.ra_job_visible(data))))
);

drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (public.ra_is_admin());

-- Field-level rules for non-administrators editing a job.
create or replace function public.ra_guard_jobs() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; locked text[] := array['bookingWindow','title','jobType','addr1','addr2','town','county','postcode',
                                         'sorg','agent','priority','minutes','jobPrice','custName','custEmail','custPhone','org'];
begin
  if new.coll <> 'jobs' or public.ra_is_admin() then return new; end if;
  if tg_op = 'UPDATE' then
    if coalesce(new.data->>'org','') is distinct from coalesce(old.data->>'org','') then
      raise exception 'Only a system administrator can change the organisation of a job' using errcode = '42501';
    end if;
    if public.ra_is_agent() then
      foreach k in array locked loop
        if coalesce(new.data->k,'null'::jsonb) is distinct from coalesce(old.data->k,'null'::jsonb) then
          raise exception 'Service agents cannot change %', k using errcode = '42501';
        end if;
      end loop;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ra_guard_jobs on public.docs;
create trigger ra_guard_jobs before insert or update on public.docs
  for each row execute function public.ra_guard_jobs();

-- Only administrators may write people / organisations / setup data (covered above:
-- non-admins cannot insert, update or delete outside jobs, blobs and meta).

-- ---------------------------------------------------------------------------
-- Live updates between users
-- ---------------------------------------------------------------------------
alter table public.docs replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Job numbers allocated by the database (used by the app and by the API below).
-- The counter lives in the 'meta/app' record as jobSeq; it can never go backwards.
-- ---------------------------------------------------------------------------
create or replace function public.ra_next_job_number() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.role() <> 'service_role' and not public.ra_is_active() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  insert into public.docs (path, coll, id, data)
  values ('meta/app', 'meta', 'app', jsonb_build_object('jobSeq', 1560))
  on conflict (path) do update
    set data = jsonb_set(docs.data, '{jobSeq}', to_jsonb(coalesce((docs.data->>'jobSeq')::int, 1559) + 1))
  returning (data->>'jobSeq')::int into n;
  return n;
end $$;
revoke all on function public.ra_next_job_number() from public, anon;
grant execute on function public.ra_next_job_number() to authenticated, service_role;

create or replace function public.ra_meta_seq_guard() returns trigger
language plpgsql as $$
begin
  if new.path = 'meta/app' and tg_op = 'UPDATE' and (old.data ? 'jobSeq') then
    new.data := jsonb_set(new.data, '{jobSeq}',
      to_jsonb(greatest(coalesce((new.data->>'jobSeq')::int, 0), (old.data->>'jobSeq')::int)));
  end if;
  return new;
end $$;
drop trigger if exists ra_meta_seq_guard on public.docs;
create trigger ra_meta_seq_guard before update on public.docs
  for each row execute function public.ra_meta_seq_guard();

create unique index if not exists docs_job_number_uq on public.docs ((data->>'number')) where coll = 'jobs';
create index if not exists docs_jobs_extref_idx on public.docs ((data->>'org'), (data->>'extRef')) where coll = 'jobs';

-- ---------------------------------------------------------------------------
-- API keys for outside systems. Only a hash of each key is stored.
-- Create one (as a database admin, in the SQL editor):
--   select * from public.ra_create_api_key('CRM system');
-- The key is shown once. To switch one off:
--   update public.ra_api_keys set active = false where name = 'CRM system';
-- ---------------------------------------------------------------------------
create table if not exists public.ra_api_keys (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  key_hash    text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  last_used   timestamptz
);
alter table public.ra_api_keys enable row level security;
alter table public.ra_api_keys force row level security;
revoke all on public.ra_api_keys from public, anon, authenticated;

create or replace function public.ra_create_api_key(p_name text) returns table (api_key text, name text)
language plpgsql security definer set search_path = public, extensions as $$
declare k text := 'ra_' || encode(gen_random_bytes(24), 'hex');
begin
  insert into public.ra_api_keys (name, key_hash) values (p_name, encode(digest(k, 'sha256'), 'hex'));
  return query select k, p_name;
end $$;
revoke all on function public.ra_create_api_key(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Create a job from an outside system. Called by the create-job Edge Function
-- (service role only). Errors use codes: RA401 bad key, RA422 bad data.
-- A repeat of the same extRef for the same organisation returns the existing job.
-- ---------------------------------------------------------------------------
create or replace function public.ra_api_create_job(p jsonb, p_key text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  kid uuid; kname text; org jsonb; jt jsonb; pri text; jid text; num integer; j jsonb; pc text;
  ext text := btrim(coalesce(p->>'extRef','')); ttl text := btrim(coalesce(p->>'title',''));
  cn text := btrim(coalesce(p->>'custName','')); a1 text := btrim(coalesce(p->>'addr1',''));
  lim numeric; basis text := ''; al text; mins numeric; em text := btrim(coalesce(p->>'custEmail',''));
  ex jsonb; f text;
begin
  select id, name into kid, kname from public.ra_api_keys
   where active and key_hash = encode(digest(coalesce(p_key,''), 'sha256'), 'hex');
  if kid is null then raise exception 'Invalid or missing API key' using errcode = 'RA401'; end if;
  update public.ra_api_keys set last_used = now() where id = kid;

  if jsonb_typeof(p) is distinct from 'object' then raise exception 'The body must be a JSON object' using errcode = 'RA422'; end if;
  foreach f in array array['title','custName','addr1','postcode'] loop
    if btrim(coalesce(p->>f,'')) = '' then raise exception '% is required', f using errcode = 'RA422'; end if;
  end loop;
  if coalesce(p->>'org','') = '' and coalesce(p->>'orgName','') = '' then
    raise exception 'org (organisation id) or orgName is required' using errcode = 'RA422'; end if;
  if coalesce(p->>'jobType','') = '' and coalesce(p->>'jobTypeName','') = '' then
    raise exception 'jobType (job type id) or jobTypeName is required' using errcode = 'RA422'; end if;
  if length(ttl) > 200 or length(cn) > 200 or length(a1) > 200 or length(ext) > 100
     or length(coalesce(p->>'notes','')) > 4000 then
    raise exception 'A field is too long' using errcode = 'RA422'; end if;
  if em <> '' and em !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'custEmail is not a valid email address' using errcode = 'RA422'; end if;

  select data into org from public.docs where coll = 'orgs'
    and data->>'orgType' = 'Customer' and data->>'status' = 'Active'
    and ((coalesce(p->>'org','') <> '' and data->>'id' = p->>'org')
      or (coalesce(p->>'org','') = '' and lower(data->>'name') = lower(btrim(p->>'orgName')))) limit 1;
  if org is null then raise exception 'No active customer organisation matches' using errcode = 'RA422'; end if;

  select data into jt from public.docs where coll = 'jobTypes'
    and ((coalesce(p->>'jobType','') <> '' and data->>'id' = p->>'jobType')
      or (coalesce(p->>'jobType','') = '' and lower(data->>'name') = lower(btrim(p->>'jobTypeName')))) limit 1;
  if jt is null then raise exception 'No job type matches' using errcode = 'RA422'; end if;

  pc := upper(regexp_replace(p->>'postcode', '\s+', '', 'g'));
  if pc !~ '^(GIR0AA|[A-PR-UWYZ]([0-9]{1,2}|([A-HK-Y][0-9]([0-9ABEHMNPRV-Y])?)|[0-9][A-HJKPS-UW])[0-9][ABD-HJLNP-UW-Z]{2})$' then
    raise exception 'postcode is not a valid UK postcode' using errcode = 'RA422'; end if;
  pc := left(pc, length(pc) - 3) || ' ' || right(pc, 3);

  if coalesce(p->>'priority','') <> '' then
    select data->>'description' into pri from public.docs where coll = 'priorities'
      and lower(data->>'description') = lower(btrim(p->>'priority')) limit 1;
    if pri is null then raise exception 'priority does not match a priority set up in the system' using errcode = 'RA422'; end if;
  else
    select coalesce((select data->>'description' from public.docs where coll = 'priorities' and data->>'description' = 'Normal' limit 1),
                    (select data->>'description' from public.docs where coll = 'priorities' order by path limit 1), '') into pri;
  end if;

  -- Same extRef for the same organisation: return the job already created.
  if ext <> '' then
    select data into ex from public.docs where coll = 'jobs' and data->>'org' = org->>'id' and data->>'extRef' = ext limit 1;
    if ex is not null then
      return jsonb_build_object('id', ex->>'id', 'number', (ex->>'number')::int, 'duplicate', true);
    end if;
  end if;

  -- Job limit from the organisation's Job Auth settings (same rules as the app).
  al := coalesce(org->>'authLimit', 'No Limit');
  if al = 'Job Limit' then
    lim := coalesce(nullif(org->>'jobLimit','')::numeric, 100); basis := coalesce(org->>'limitType', 'Job Total');
  elsif al = 'Job Type Limit' then
    lim := coalesce(nullif((org->'jobTypeLimits')->>(jt->>'id'),'')::numeric, 100); basis := coalesce(org->>'limitType', 'Job Total');
  end if;

  mins := coalesce(nullif(p->>'minutes','')::numeric, nullif(jt->>'minutes','')::numeric);
  num := public.ra_next_job_number();
  jid := 'x' || substr(encode(gen_random_bytes(8), 'hex'), 1, 10);
  j := jsonb_build_object(
    'id', jid, 'number', num, 'title', ttl, 'extRef', ext, 'status', 'New', 'priority', pri,
    'org', org->>'id', 'jobType', jt->>'id', 'sorg', '', 'agent', '', 'date', '', 'bookingWindow', '',
    'minutes', to_jsonb(mins),
    'custName', cn, 'custEmail', em, 'custPhone', btrim(coalesce(p->>'custPhone','')),
    'addr1', a1, 'addr2', btrim(coalesce(p->>'addr2','')), 'town', btrim(coalesce(p->>'town','')),
    'county', btrim(coalesce(p->>'county','')), 'postcode', pc,
    'notes', coalesce(p->>'notes',''), 'jobPrice', null,
    'jobLimit', to_jsonb(lim), 'jobLimitBasis', basis,
    'created', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'history', jsonb_build_array(jsonb_build_object('at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'by', 'API: ' || kname, 'note', 'Job created', 'statusChanged', false, 'bookingChanged', false, 'changes', '[]'::jsonb)));
  insert into public.docs (path, coll, id, data) values ('jobs/' || jid, 'jobs', jid, j);
  return jsonb_build_object('id', jid, 'number', num, 'duplicate', false);
end $$;
revoke all on function public.ra_api_create_job(jsonb, text) from public, anon, authenticated;
grant execute on function public.ra_api_create_job(jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- Sign-ups are closed once a SYSADMIN exists. Only the very first account (which
-- becomes the SYSADMIN) can be created through the sign-up screen. After that an
-- administrator creates accounts from the person form (Edge Function
-- set-user-password -> ra_admin_set_password), so no confirmation emails are needed.
-- ---------------------------------------------------------------------------
create or replace function public.ra_signup_open() returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.docs where coll = 'users' and data->>'role' = 'SYSADMIN')
$$;
grant execute on function public.ra_signup_open() to anon, authenticated;

create or replace function public.ra_before_signup() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare em text := lower(coalesce(new.email,'')); has_admin boolean; nm text;
begin
  perform pg_advisory_xact_lock(7770001);
  select exists (select 1 from public.docs where coll = 'users' and data->>'role' = 'SYSADMIN') into has_admin;
  nm := coalesce(nullif(new.raw_user_meta_data->>'name',''), split_part(em,'@',1));
  if not has_admin then
    if exists (select 1 from public.docs where coll = 'users' and lower(data->>'email') = em) then
      update public.docs set data = data || '{"role":"SYSADMIN","status":"Active"}'::jsonb
        where coll = 'users' and lower(data->>'email') = em;
    else
      insert into public.docs (path, coll, id, data)
      select 'users/'||x, 'users', x, jsonb_build_object('id', x, 'name', nm, 'email', em, 'phone', '',
             'role','SYSADMIN','status','Active','org','','personType','System User')
      from (select 'u'||substr(encode(gen_random_bytes(8),'hex'),1,10) as x) s;
    end if;
  elsif coalesce(current_setting('ra.allow_signup', true), '') <> '1' then
    raise exception 'Sign-ups are closed. Ask an administrator to create your account.' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function public.ra_admin_set_password(p_email text, p_password text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare em text := lower(btrim(coalesce(p_email,''))); uid uuid;
begin
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address' using errcode = 'RA422'; end if;
  if length(coalesce(p_password,'')) < 10 or length(p_password) > 72 then
    raise exception 'The password must be between 10 and 72 characters' using errcode = 'RA422'; end if;
  select id into uid from auth.users where lower(email) = em;
  if uid is not null then
    update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = uid;
    return jsonb_build_object('created', false);
  end if;
  perform set_config('ra.allow_signup', '1', true);
  uid := gen_random_uuid();
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
      reauthentication_token, phone_change, phone_change_token)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
      crypt(p_password, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}',
      jsonb_build_object('name', coalesce((select data->>'name' from public.docs where coll = 'users' and lower(data->>'email') = em limit 1), split_part(em,'@',1))),
      now(), now(), '', '', '', '', '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (uid::text, uid, jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now());
  return jsonb_build_object('created', true);
end $$;
revoke all on function public.ra_admin_set_password(text, text) from public, anon, authenticated;
grant execute on function public.ra_admin_set_password(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Photo storage. Photos live as files in a private Storage bucket ("photos"),
-- one object per image, named by its content hash. Only active people can read
-- or add photos; only administrators can delete them.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('photos', 'photos', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

drop policy if exists ra_photos_read on storage.objects;
create policy ra_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.ra_is_active());
drop policy if exists ra_photos_add on storage.objects;
create policy ra_photos_add on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.ra_is_active());
drop policy if exists ra_photos_del on storage.objects;
create policy ra_photos_del on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.ra_is_admin());

-- Person type renamed: Service Agent -> Repair Agent
update public.docs set data = jsonb_set(data,'{personType}','"Repair Agent"') where coll='users' and data->>'personType'='Service Agent';
