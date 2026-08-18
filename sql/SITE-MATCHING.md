# The site string and the column matching

Two separate things have to line up, and they fail in different ways.

1. **The site string** — one piece of text that must be byte-identical in three
   places. Get it wrong and a PC is silently locked out.
2. **The column names** — what `user_sites` actually calls its columns. Get it
   wrong and the SQL errors immediately, which is the easier failure.

---

# Part 1 — The site string

## Where it comes from

Settings → **Site Code**. The app does not send what you type; it normalises it
first, then sends the result. Same rule every time:

    lower case  →  anything not a-z 0-9 becomes a hyphen  →  trim hyphens

Verified output:

| Typed in Site Code  | Sent to the database  |
|---------------------|-----------------------|
| `hillside`          | `hillside`            |
| `Hillside Complex`  | `hillside-complex`    |
| `Prime Coal`        | `prime-coal`          |
| `Prime-Coal`        | `prime-coal`          |
| `HILL_SIDE!!`       | `hill-side`           |
| `  Hillside  `      | `hillside`            |
| `Site 2`            | `site-2`              |

If **Site Code is left blank**, it falls back to a slug of **Site Name**:

| Site Code | Site Name             | Sent            |
|-----------|-----------------------|-----------------|
| *(blank)* | `Woestaleen Colliery` | `woestaleen-colliery` |
| *(blank)* | *(blank)*             | `unset`         |

`unset` is deliberate — it shows up as an obvious wrong value in a report
instead of an empty string that hides.

**Recommendation: type the short form.** `hillside`, `primecoal`. Short codes
survive a client renaming their site; `hillside-complex` does not.

## The three places it must match

```
   Settings → Site Code
        │  normalised by the app
        ▼
   'hillside'  ────────────────►  transactions.site      (written on every ticket)
        │
        └───────────────────────►  user_sites.site        (what the login is allowed to touch)
```

The RLS policy is nothing more than a string comparison between those last two.
`'hillside'` ≠ `'Hillside'` ≠ `'hillside '` ≠ `'hillside-complex'`. Postgres
does not care that they look the same to you.

**This is why the app normalises.** An operator typing `Hillside ` with a
trailing space would otherwise lock their own PC out. The normaliser means the
only value you have to be careful with is the one *you* type into
`user_sites` — so paste it, do not retype it:

```sql
-- copy the exact string the app is already sending, don't type it fresh
select distinct site from public.transactions order by site;
```

`04_match_check.sql` finds every mismatch, including the near misses that look
identical on screen. Run it before step 5 and after.

## Guard rail

The last block of `04` adds a check constraint so nothing outside that shape
can ever be written again:

```sql
check (site ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
```

---

# Part 2 — The column matching

Every policy in `03_site_auth_rls.sql` goes through **one function**. That is
the only place your column names appear, so this is a single edit no matter how
many tables you protect later.

```sql
create or replace function public.iss_may_use_site(p_site text)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from public.user_sites us
    where us.user_id = auth.uid()      -- ← column A
      and us.site    = p_site          -- ← column B
  );
$$;
```

Run block **1a** of `01_inspect.sql` and match what it prints to one of these.

## Case 1 — columns are `user_id` and `site`

Nothing to change. Ship `03` as written.

## Case 2 — different names, same idea

Say `01a` prints `uid` and `site_code`. Change the two marked lines only:

```sql
    where us.uid       = auth.uid()
      and us.site_code = p_site
```

## Case 3 — the site is a foreign key, not text

`01a` prints `site_id uuid` and there is a separate `sites` table. The join
moves into the helper; everything else is untouched:

```sql
create or replace function public.iss_may_use_site(p_site text)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1
    from public.user_sites us
    join public.sites s on s.id = us.site_id
    where us.user_id = auth.uid()
      and s.code     = p_site        -- the short code column on sites
  );
$$;
```

If `sites` has no short-code column, add one and fill it with the same strings
the app sends:

```sql
alter table public.sites add column if not exists code text unique;
update public.sites set code = 'hillside'  where name ilike '%hillside%';
update public.sites set code = 'primecoal' where name ilike '%prime%';
```

## Case 4 — `user_sites` does not exist yet

Create it. This is the whole table:

```sql
create table if not exists public.user_sites (
  user_id uuid not null references auth.users(id) on delete cascade,
  site    text not null,
  primary key (user_id, site)
);
alter table public.user_sites enable row level security;

-- a signed-in PC may read its own row and nothing else
create policy us_self_select on public.user_sites
  for select to authenticated using (user_id = auth.uid());
```

The composite primary key means one login can be linked to several sites — how
you would give the office account read access to everything:

```sql
insert into public.user_sites (user_id, site) values
  ('<office-uuid>', 'hillside'),
  ('<office-uuid>', 'primecoal');
```

---

# Proving it works

As the Hillside login:

```sql
-- must return Hillside rows only
select site, count(*) from public.transactions group by site;

-- must FAIL with a row-level security violation
insert into public.transactions (row_id, site, ticket)
values (gen_random_uuid(), 'primecoal', 'WB999');
```

If that insert succeeds, the helper is not matching — nine times out of ten
because `user_sites.site` holds a different string from the one the app sends.
Run `04_match_check.sql` block 4d; it is built to find exactly that.
