# Multi-site cloud sync — order of operations

The one rule: **do not put a secret key on a weighbridge PC.** A secret key
(`sb_secret_…`, formerly `service_role`) bypasses Row Level Security entirely.
Anyone with the app can open `renderer/index.html` in Notepad and read it.
Every step below exists to make the site PCs work with the *publishable* key
instead, which is safe to ship because RLS stands between it and the data.

---

## Order

**1 · Inspect** — run `01_inspect.sql`, block by block.
Two answers change what follows:
- the real column names in `user_sites` (needed in step 4)
- whether duplicate ticket numbers already exist (blocks step 2)

**2 · Keys** — edit the `existing_site` line at the top of `02_keys.sql` to the
site that uploaded the rows already in the table, then run it. Adds `row_id`
and `site`, backfills history, and swaps the ticket uniqueness rule from
"unique everywhere" to "unique per site".

**3 · Ship app 9.2.0 to site, set the Site Code** — Settings → Site Code:
`hillside`, `primecoal`. Do this before step 5 or that PC's writes start
failing. The app backfills its own local history on first launch.

**4 · One login per weighbridge PC**
- Supabase Dashboard → Authentication → Users → **Add user**
  (`hillside-wb1@yourdomain.co.za`, strong password, auto-confirm).
- Copy the user's UUID.
- Link it to the site:
  ```sql
  insert into public.user_sites (user_id, site)
  values ('<uuid-from-dashboard>', 'hillside');
  ```
- Repeat per PC. Two PCs at one site get two accounts, both linked to
  `hillside` — never share one login, or you cannot tell them apart or revoke
  one of them.

**5 · Turn on scoped access** — run `03_site_auth_rls.sql`.
From here the site PCs must sign in; anonymous writes stop working.

**6 · Rotate the exposed key** — Settings → API Keys → revoke the old
`service_role` / secret key that was flagged on GitHub. Nothing should still
depend on it. This is the step that has been outstanding; do not skip it now
that nothing needs it.

---

## What the app stores after this

- **Publishable key** (`sb_publishable_…`) — shipped in the app, safe.
- **Site login** — email + password entered once in Settings, stored in the
  app's own state file, not in source.
- **No secret key anywhere on site.**

---

## Verifying it actually worked

Sign in as the Hillside account and run:

```sql
select site, count(*) from public.transactions group by site;
```

You should see Hillside's rows only. If Primecoal's appear, the policy is not
matching — check that `user_sites.site` holds exactly the same string the app
sends as its Site Code (lower case, no spaces).

Then try to cheat, as the Hillside account:

```sql
insert into public.transactions (row_id, site, ticket)
values (gen_random_uuid(), 'primecoal', 'WB999');
```

This **must** fail with a row-level security violation. If it succeeds, stop
and re-check step 4 before rolling out further.

---

## Notes for later

- Legacy `anon` / `service_role` keys are being retired by Supabase at the end
  of 2026, so this migration was coming regardless.
- Orders and fleet flow the opposite way — the office writes, sites read. The
  read policy is sketched in `03` (section 3d), commented out until those
  tables exist.
- The sync module inside the app should queue to disk and retry. A weigh must
  never wait on the network.
