-- ═══════════════════════════════════════════════════════════════════
-- ISS · STEP 2 — SITE + ROW ID ON TRANSACTIONS
-- Stops ticket WB001 from Hillside and WB001 from Primecoal colliding.
-- Safe to re-run. Does not delete anything.
--
-- BEFORE RUNNING: set the site code that existing rows belong to.
-- Every row already in the table was uploaded by one site — name it here.
-- ═══════════════════════════════════════════════════════════════════
\set existing_site 'hillside'

begin;

-- 2a. Columns. row_id is the cloud identity of a transaction; the app now
--     generates it on the weighbridge PC when the truck first drives on.
alter table public.transactions add column if not exists row_id uuid;
alter table public.transactions add column if not exists site   text;

-- 2b. Backfill history. Rows uploaded before 9.2.0 have neither.
update public.transactions set row_id = gen_random_uuid() where row_id is null;
update public.transactions set site   = :'existing_site'   where site   is null or site = '';

-- 2c. Now they can be required.
alter table public.transactions alter column row_id set not null;
alter table public.transactions alter column site   set not null;
alter table public.transactions alter column row_id set default gen_random_uuid();

-- 2d. row_id is what upserts key on, so it must be unique on its own.
--     A re-send after a dropped connection then updates the same row instead
--     of creating a second ticket.
create unique index if not exists transactions_row_id_uk
  on public.transactions (row_id);

-- 2e. A ticket number must be unique WITHIN a site, not across all of them.
--     Both sites keep counting from 001; a genuine double-issue at one site
--     is still refused.
--     If this fails, duplicates already exist — run 1d and resolve them first.
create unique index if not exists transactions_site_ticket_uk
  on public.transactions (site, ticket);

-- 2f. Reporting nearly always filters by site and date.
create index if not exists transactions_site_time_ix
  on public.transactions (site, time_in desc);

commit;

-- 2g. Check it worked.
select site, count(*) as tickets, min(ticket) as first_ticket, max(ticket) as last_ticket
from public.transactions group by site order by site;
