-- ═══════════════════════════════════════════════════════════════════
-- ISS · STEP 3 — SCOPED ACCESS PER SITE
-- Replaces "any anon key can read and write everything" with
-- "this PC can only touch its own site's rows".
--
-- Run AFTER step 2, and AFTER creating a Supabase Auth user per
-- weighbridge PC and linking it in user_sites (see RUNBOOK.md).
--
-- ── ADJUST IF NEEDED ──────────────────────────────────────────────
-- These policies assume:  user_sites(user_id uuid, site text)
-- Script 01a tells you the real column names. If yours are different,
-- change them in the helper function below — it is the ONLY place
-- they appear, so one edit covers every policy.
-- ═══════════════════════════════════════════════════════════════════

begin;

-- 3a. One helper, used by every policy. Returns true when the signed-in
--     account is linked to that site.
create or replace function public.iss_may_use_site(p_site text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_sites us
    where us.user_id = auth.uid()      -- << column name, adjust if different
      and us.site    = p_site          -- << column name, adjust if different
  );
$$;

revoke all on function public.iss_may_use_site(text) from public, anon;
grant execute on function public.iss_may_use_site(text) to authenticated;

-- 3b. Transactions — a site inserts and reads only its own tickets.
alter table public.transactions enable row level security;

drop policy if exists tx_site_select on public.transactions;
drop policy if exists tx_site_insert on public.transactions;
drop policy if exists tx_site_update on public.transactions;

create policy tx_site_select on public.transactions
  for select to authenticated
  using (public.iss_may_use_site(site));

create policy tx_site_insert on public.transactions
  for insert to authenticated
  with check (public.iss_may_use_site(site));

-- Update is needed so a re-send after a dropped connection can correct a row.
-- The WITH CHECK stops a PC moving a ticket to another site.
create policy tx_site_update on public.transactions
  for update to authenticated
  using (public.iss_may_use_site(site))
  with check (public.iss_may_use_site(site));

-- Deliberately no DELETE policy: a weighbridge PC can never delete a ticket.

-- 3c. Readings — same rule, keyed on whatever column carries the site.
--     (If readings uses "site" too, this is copy-paste identical.)
alter table public.readings enable row level security;

drop policy if exists rd_site_select on public.readings;
drop policy if exists rd_site_insert on public.readings;

create policy rd_site_select on public.readings
  for select to authenticated
  using (public.iss_may_use_site(site));

create policy rd_site_insert on public.readings
  for insert to authenticated
  with check (public.iss_may_use_site(site));

-- 3d. Orders and fleet flow the OTHER way — the office writes, sites read.
--     Create these tables first if they do not exist yet; the read policy is
--     what lets a weighbridge PC pull its orders down.
-- alter table public.orders enable row level security;
-- create policy ord_site_select on public.orders
--   for select to authenticated using (public.iss_may_use_site(site));
-- (no insert/update policy for authenticated: only the office backend writes)

-- 3e. Close the old door. Anonymous access is what the exposed key relied on.
drop policy if exists "anon insert readings"     on public.readings;
drop policy if exists "anon select readings"     on public.readings;
drop policy if exists "anon insert transactions" on public.transactions;
drop policy if exists "anon select transactions" on public.transactions;
-- Anything else 01e listed with roles={anon} should be dropped here too.

commit;

-- 3f. Verify: this should list only the policies created above, all for
--     the authenticated role.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname='public' and tablename in ('transactions','readings')
order by tablename, policyname;
