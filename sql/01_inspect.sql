-- ═══════════════════════════════════════════════════════════════════
-- ISS · STEP 1 — LOOK BEFORE YOU TOUCH
-- Run each block in the Supabase SQL editor and read the output.
-- Nothing here changes any data.
-- ═══════════════════════════════════════════════════════════════════

-- 1a. What columns does user_sites actually have? Scripts 02 and 03 assume
--     user_sites(user_id uuid, site text). If yours differs, change the two
--     marked lines in 03 to match what this returns.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='user_sites'
order by ordinal_position;

-- 1b. Same for transactions — confirm the ticket column is called "ticket".
select column_name, data_type
from information_schema.columns
where table_schema='public' and table_name='transactions'
order by ordinal_position;

-- 1c. Any constraint that already treats the ticket number as unique?
--     If one exists it is the thing that will reject or overwrite Primecoal's
--     WB001, and it must be dropped in step 2.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid='public.transactions'::regclass;

select indexname, indexdef from pg_indexes
where schemaname='public' and tablename='transactions';

-- 1d. Do duplicate ticket numbers ALREADY exist? If this returns rows, the
--     unique index in step 2 will fail until they are sorted out.
select ticket, count(*) as copies
from public.transactions
group by ticket
having count(*) > 1
order by copies desc, ticket
limit 50;

-- 1e. Is RLS on, and what policies exist right now?
select relname, relrowsecurity as rls_enabled
from pg_class where oid='public.transactions'::regclass;

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname='public'
order by tablename, policyname;
