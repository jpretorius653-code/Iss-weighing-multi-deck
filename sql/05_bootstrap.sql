-- ═══════════════════════════════════════════════════════════════════
-- ISS · BOOTSTRAP — paste this ONCE into the Supabase SQL editor.
--
-- It creates four functions. After this you never open the SQL editor
-- again: the app's Cloud tab calls these to inspect the backend, build
-- or repair it, and register each site.
--
-- BEFORE RUNNING: put your own login email on the line marked ADMIN.
-- That account becomes the only one allowed to change the backend.
-- ═══════════════════════════════════════════════════════════════════

begin;

-- ── who may provision ─────────────────────────────────────────────
create table if not exists public.iss_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.iss_admins enable row level security;

drop policy if exists iss_admins_self on public.iss_admins;
create policy iss_admins_self on public.iss_admins
  for select to authenticated using (user_id = auth.uid());

-- ADMIN: your Supabase Auth account. Create it in Authentication → Users first.
insert into public.iss_admins (user_id)
select id from auth.users where email = 'CHANGE-ME@yourdomain.co.za'
on conflict (user_id) do nothing;

create or replace function public.iss_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.iss_admins a where a.user_id = auth.uid());
$$;
grant execute on function public.iss_is_admin() to authenticated;

-- ── 1. iss_status() — what does the backend look like right now? ──
-- Read-only. This is what fills the checklist in the Cloud tab, and it is
-- what works out your user_sites column names instead of you reading them
-- off a query and typing them into a script.
create or replace function public.iss_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb := '{}'::jsonb;
  v_user_col text;
  v_site_col text;
  v_site_type text;
begin
  if not public.iss_is_admin() then
    return jsonb_build_object('error','not an ISS admin');
  end if;

  -- which column in user_sites holds the auth user, and which holds the site
  select column_name into v_user_col from information_schema.columns
   where table_schema='public' and table_name='user_sites'
     and column_name = any (array['user_id','uid','auth_user_id','user','account_id'])
   order by array_position(array['user_id','uid','auth_user_id','user','account_id'], column_name)
   limit 1;

  select column_name, data_type into v_site_col, v_site_type
    from information_schema.columns
   where table_schema='public' and table_name='user_sites'
     and column_name = any (array['site','site_code','site_id','sitename'])
   order by array_position(array['site','site_code','site_id','sitename'], column_name)
   limit 1;

  r := jsonb_build_object(
    'tables', (select jsonb_object_agg(t, ex) from (
        select t, to_regclass('public.'||t) is not null as ex
        from unnest(array['transactions','readings','user_sites','sites','orders','fleet']) t) x),
    'transactions_columns', (select coalesce(jsonb_agg(column_name order by column_name),'[]'::jsonb)
        from information_schema.columns
        where table_schema='public' and table_name='transactions'),
    'has_row_id', exists (select 1 from information_schema.columns
        where table_schema='public' and table_name='transactions' and column_name='row_id'),
    'has_site', exists (select 1 from information_schema.columns
        where table_schema='public' and table_name='transactions' and column_name='site'),
    'indexes', (select coalesce(jsonb_agg(indexname order by indexname),'[]'::jsonb)
        from pg_indexes where schemaname='public' and tablename='transactions'),
    'rls', (select coalesce(jsonb_object_agg(c.relname, c.relrowsecurity),'{}'::jsonb)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname in ('transactions','readings','user_sites')),
    'policies', (select coalesce(jsonb_agg(jsonb_build_object(
          'table',tablename,'name',policyname,'cmd',cmd,'roles',roles) order by tablename,policyname),'[]'::jsonb)
        from pg_policies where schemaname='public'
          and tablename in ('transactions','readings','user_sites')),
    'user_sites_user_col', v_user_col,
    'user_sites_site_col', v_site_col,
    'user_sites_site_type', v_site_type,
    'helper_exists', to_regprocedure('public.iss_may_use_site(text)') is not null,
    'sites_in_transactions', (select coalesce(jsonb_agg(distinct site),'[]'::jsonb)
        from public.transactions where to_regclass('public.transactions') is not null
          and exists (select 1 from information_schema.columns
                      where table_schema='public' and table_name='transactions' and column_name='site')),
    'anon_policies_transactions', (select count(*) from pg_policies
        where schemaname='public' and tablename='transactions' and 'anon' = any(roles)),
    'anon_policies_readings', (select count(*) from pg_policies
        where schemaname='public' and tablename='readings' and 'anon' = any(roles))
  );
  return r;
end $$;
grant execute on function public.iss_status() to authenticated;

-- ── 2. iss_provision() — build or repair everything ───────────────
-- Idempotent. Safe to run again. Never deletes a ticket.
-- p_existing_site: the site code that rows already in transactions belong to.
-- p_user_col / p_site_col: only needed if iss_status() could not work out the
-- user_sites column names on its own.
create or replace function public.iss_provision(
  p_existing_site text default null,
  p_user_col      text default null,
  p_site_col      text default null,
  p_lock_readings boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  acts text[] := '{}';
  v_user_col text := p_user_col;
  v_site_col text := p_site_col;
  v_site_type text;
  v_body text;
  v_dupes int;
begin
  if not public.iss_is_admin() then
    return jsonb_build_object('ok',false,'error','not an ISS admin');
  end if;

  -- user_sites: create it if absent, otherwise detect its shape
  if to_regclass('public.user_sites') is null then
    create table public.user_sites (
      user_id uuid not null references auth.users(id) on delete cascade,
      site    text not null,
      primary key (user_id, site)
    );
    alter table public.user_sites enable row level security;
    create policy us_self_select on public.user_sites
      for select to authenticated using (user_id = auth.uid());
    v_user_col := 'user_id'; v_site_col := 'site'; v_site_type := 'text';
    acts := acts || 'created user_sites';
  else
    if v_user_col is null then
      select column_name into v_user_col from information_schema.columns
       where table_schema='public' and table_name='user_sites'
         and column_name = any (array['user_id','uid','auth_user_id','user','account_id'])
       order by array_position(array['user_id','uid','auth_user_id','user','account_id'], column_name)
       limit 1;
    end if;
    if v_site_col is null then
      select column_name into v_site_col from information_schema.columns
       where table_schema='public' and table_name='user_sites'
         and column_name = any (array['site','site_code','site_id','sitename'])
       order by array_position(array['site','site_code','site_id','sitename'], column_name)
       limit 1;
    end if;
    select data_type into v_site_type from information_schema.columns
     where table_schema='public' and table_name='user_sites' and column_name=v_site_col;
  end if;

  if v_user_col is null or v_site_col is null then
    return jsonb_build_object('ok',false,
      'error','could not work out the user_sites columns — pass them in',
      'user_col',v_user_col,'site_col',v_site_col);
  end if;

  -- transactions: keys
  if to_regclass('public.transactions') is null then
    return jsonb_build_object('ok',false,'error','table public.transactions does not exist');
  end if;

  execute 'alter table public.transactions add column if not exists row_id uuid';
  execute 'alter table public.transactions add column if not exists site text';
  acts := acts || 'ensured row_id + site columns';

  execute 'update public.transactions set row_id = gen_random_uuid() where row_id is null';
  if p_existing_site is not null and p_existing_site <> '' then
    execute format('update public.transactions set site = %L where site is null or site = %L',
                   p_existing_site, '');
    acts := acts || ('backfilled existing rows as '||p_existing_site);
  end if;

  if not exists (select 1 from public.transactions where site is null or site='') then
    execute 'alter table public.transactions alter column row_id set not null';
    execute 'alter table public.transactions alter column site set not null';
    execute 'alter table public.transactions alter column row_id set default gen_random_uuid()';
    acts := acts || 'row_id + site now required';
  else
    acts := acts || 'WARNING: rows still have no site — pass p_existing_site';
  end if;

  execute 'create unique index if not exists transactions_row_id_uk on public.transactions (row_id)';

  select count(*) into v_dupes from (
    select site, ticket from public.transactions
    where site is not null group by site, ticket having count(*) > 1) d;
  if v_dupes = 0 then
    execute 'create unique index if not exists transactions_site_ticket_uk on public.transactions (site, ticket)';
    acts := acts || 'ticket numbers now unique per site';
  else
    acts := acts || ('SKIPPED per-site unique index: '||v_dupes||' duplicate site+ticket pairs already exist');
  end if;

  -- the helper, generated to match whatever columns this project uses
  if v_site_type = 'uuid' and to_regclass('public.sites') is not null then
    v_body := format($f$
      select exists (
        select 1 from public.user_sites us
        join public.sites s on s.id = us.%I
        where us.%I = auth.uid() and s.code = p_site)$f$, v_site_col, v_user_col);
    acts := acts || 'helper joins sites.code (site stored as uuid)';
  else
    v_body := format($f$
      select exists (
        select 1 from public.user_sites us
        where us.%I = auth.uid() and us.%I = p_site)$f$, v_user_col, v_site_col);
    acts := acts || format('helper matches user_sites.%s = auth.uid() and user_sites.%s = site', v_user_col, v_site_col);
  end if;

  execute format($f$
    create or replace function public.iss_may_use_site(p_site text)
    returns boolean language sql stable security definer set search_path = public as $body$ %s $body$
  $f$, v_body);
  execute 'revoke all on function public.iss_may_use_site(text) from public, anon';
  execute 'grant execute on function public.iss_may_use_site(text) to authenticated';

  -- policies
  execute 'alter table public.transactions enable row level security';
  execute 'drop policy if exists tx_site_select on public.transactions';
  execute 'drop policy if exists tx_site_insert on public.transactions';
  execute 'drop policy if exists tx_site_update on public.transactions';
  execute 'create policy tx_site_select on public.transactions for select to authenticated
             using (public.iss_may_use_site(site))';
  execute 'create policy tx_site_insert on public.transactions for insert to authenticated
             with check (public.iss_may_use_site(site))';
  execute 'create policy tx_site_update on public.transactions for update to authenticated
             using (public.iss_may_use_site(site)) with check (public.iss_may_use_site(site))';
  acts := acts || 'transactions policies set (no delete policy — a site can never delete a ticket)';

  -- readings is left ALONE unless explicitly asked. The ESP32 gateways sign in
  -- with the publishable key as anon; switching this table to authenticated-only
  -- silences them until the firmware is re-flashed, which means a trip to site.
  if p_lock_readings
     and to_regclass('public.readings') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='readings' and column_name='site') then
    execute 'alter table public.readings enable row level security';
    execute 'drop policy if exists rd_site_select on public.readings';
    execute 'drop policy if exists rd_site_insert on public.readings';
    execute 'create policy rd_site_select on public.readings for select to authenticated
               using (public.iss_may_use_site(site))';
    execute 'create policy rd_site_insert on public.readings for insert to authenticated
               with check (public.iss_may_use_site(site))';
    acts := acts || 'readings locked to authenticated — RE-FLASH THE GATEWAYS or they stop posting';
  else
    acts := acts || 'readings left as-is (ESP32 gateways keep working)';
  end if;

  -- Deliberately NOT dropping anon policies on readings here: that is what the
  -- gateways and the current dashboard build rely on. Retire them from the
  -- Cloud tab once both can sign in.

  return jsonb_build_object('ok',true,'actions',to_jsonb(acts),
    'user_col',v_user_col,'site_col',v_site_col);
end $$;
grant execute on function public.iss_provision(text,text,text,boolean) to authenticated;

-- ── 3. iss_register_site() — link a login to a site by email ──────
-- Saves copying UUIDs out of the dashboard.
create or replace function public.iss_register_site(p_email text, p_site text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_user_col text; v_site_col text;
begin
  if not public.iss_is_admin() then
    return jsonb_build_object('ok',false,'error','not an ISS admin');
  end if;
  if p_site !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    return jsonb_build_object('ok',false,'error','site code must be lower case letters, digits and hyphens');
  end if;

  select id into v_id from auth.users where lower(email) = lower(p_email);
  if v_id is null then
    return jsonb_build_object('ok',false,
      'error','no Supabase Auth user with that email — create it in Authentication → Users first');
  end if;

  select column_name into v_user_col from information_schema.columns
   where table_schema='public' and table_name='user_sites'
     and column_name = any (array['user_id','uid','auth_user_id','user','account_id'])
   order by array_position(array['user_id','uid','auth_user_id','user','account_id'], column_name) limit 1;
  select column_name into v_site_col from information_schema.columns
   where table_schema='public' and table_name='user_sites'
     and column_name = any (array['site','site_code','sitename'])
   order by array_position(array['site','site_code','sitename'], column_name) limit 1;

  if v_user_col is null or v_site_col is null then
    return jsonb_build_object('ok',false,'error','run Set up / repair first');
  end if;

  execute format('insert into public.user_sites (%I,%I) values (%L,%L) on conflict do nothing',
                 v_user_col, v_site_col, v_id, p_site);
  return jsonb_build_object('ok',true,'email',p_email,'site',p_site,'user_id',v_id);
end $$;
grant execute on function public.iss_register_site(text,text) to authenticated;

-- ── 4. iss_my_sites() — what is THIS login allowed to touch? ──────
-- Any signed-in account may call it about itself. The Cloud tab uses it to
-- tell an operator "this PC is registered for hillside" before anything breaks.
create or replace function public.iss_my_sites()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_user_col text; v_site_col text; v_out jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('signed_in',false); end if;
  select column_name into v_user_col from information_schema.columns
   where table_schema='public' and table_name='user_sites'
     and column_name = any (array['user_id','uid','auth_user_id','user','account_id']) limit 1;
  select column_name into v_site_col from information_schema.columns
   where table_schema='public' and table_name='user_sites'
     and column_name = any (array['site','site_code','sitename']) limit 1;
  if v_user_col is null or v_site_col is null then
    return jsonb_build_object('signed_in',true,'sites','[]'::jsonb,'note','backend not set up yet');
  end if;
  execute format('select coalesce(jsonb_agg(%I),%L::jsonb) from public.user_sites where %I = auth.uid()',
                 v_site_col, '[]', v_user_col) into v_out;
  return jsonb_build_object('signed_in',true,'sites',v_out,'admin',public.iss_is_admin());
end $$;
grant execute on function public.iss_my_sites() to authenticated;

commit;

-- Done. Open the app → Cloud tab → sign in as the admin account →
-- Check backend → Set up / repair.
