-- ═══════════════════════════════════════════════════════════════════
-- ISS · STEP 4 — DOES THE SITE STRING ACTUALLY MATCH?
-- Read-only. Run this after 02 and again after 03.
-- Every "no match" row below is a PC that will be locked out.
-- ═══════════════════════════════════════════════════════════════════

-- 4a. What site strings exist on each side?
select 'transactions' as source, site, count(*) as rows
from public.transactions group by site
union all
select 'user_sites', site, count(*)
from public.user_sites group by site
order by source, site;

-- 4b. Site strings that tickets use but no login is linked to.
--     These sites can upload nothing once RLS is on.
select t.site as ticket_site, count(*) as orphan_tickets
from public.transactions t
where not exists (select 1 from public.user_sites us where us.site = t.site)
group by t.site
order by orphan_tickets desc;

-- 4c. Logins pointing at a site string no ticket has ever used.
--     Usually a typo, or a plural/singular mismatch.
select us.site as login_site, count(*) as logins
from public.user_sites us
where not exists (select 1 from public.transactions t where t.site = us.site)
group by us.site;

-- 4d. Near misses — the ones that look identical in the dashboard but are not.
--     Catches trailing spaces, capitals, and underscore-vs-hyphen.
select distinct t.site as ticket_site, us.site as login_site
from public.transactions t
join public.user_sites us
  on lower(regexp_replace(btrim(t.site),  '[^a-zA-Z0-9]+','-','g'))
   = lower(regexp_replace(btrim(us.site), '[^a-zA-Z0-9]+','-','g'))
where t.site <> us.site;

-- 4e. Anything the app sent before a Site Code was configured.
select count(*) as unset_tickets
from public.transactions where site = 'unset';

-- 4f. Guard rail: stop bad values getting in from now on.
--     Same shape the app produces — lower case, digits, hyphens.
alter table public.transactions
  drop constraint if exists transactions_site_shape_ck;
alter table public.transactions
  add constraint transactions_site_shape_ck
  check (site ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
