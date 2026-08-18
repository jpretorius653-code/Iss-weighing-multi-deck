# ISS Weighbridge

Electron desktop app by **Industrial Scale Solutions** (Reg. 2025/316125/07), eMalahleni.
Weighbridge control, ticketing, reporting, shared database, fleet list.

## Repo layout
```
package.json                   build config + scripts
build/                         icon.ico, icon.png
electron/                      main.js, preload.js, serial.js, tcp.js, storage.js, installer.nsh
renderer/                      index.html   (the whole app UI)
.github/workflows/build.yml    cloud build
```

## Build in the cloud (no tools needed)
1. Push this repo to GitHub.
2. Open the **Actions** tab → wait ~5 min for "Build Windows EXE" to finish (green tick).
3. Open the run → **Artifacts** → download **ISS-Weighbridge-Setup-\<version\>** → unzip → run the Setup .exe.

Manual trigger: Actions tab → "Build Windows EXE" → **Run workflow**.

## Build locally (needs Node 22 LTS + Git + VS Build Tools "Desktop development with C++")
```bash
npm install
npm run dist
```
Output: `dist/ISS-Weighbridge-Setup-<version>.exe`

## Install activation code
The installer asks for a code before installing: **ISS2025**
(Edit `electron/installer.nsh` to change it. To remove the prompt, delete the
`"include": "electron/installer.nsh"` line from package.json → build → nsis.)

## First run
Activation code **ISS2025**, then log in as Master (default PIN **1234**).
Change the Master PIN before handing a site over.

## Upgrading an existing site (Hillside etc.)
The rename changes Windows' per-app data folder. On first launch the app
automatically copies the previous install's config and state across —
activation, users, database, orders and paired COM ports all survive.
The old folder is left untouched as a fallback. **Take a backup before upgrading**
(app menu → Open Backup Folder) as a matter of routine.

## Multi-deck bridges
Settings → Bridge → **Deck Layout**. Two choices per bridge:

- **Single deck** — one weight in the string. Unchanged behaviour.
- **Multi-deck** — the indicator sends each deck plus the gross in one string.

Setting a multi-deck bridge up:
1. Connect the indicator so numbers appear in the field list.
2. Put load on **two or more** decks, then press **Suggest mapping**. The field
   that equals the sum of the others is the gross.
3. Press **Learn** on a deck and drive an axle onto it — whichever number moves
   is that deck. Repeat per deck.
4. Watch the strip under the header: if the decks add up to the gross, the
   mapping is right.

The ticket always records the gross, so reports and existing tickets are
unaffected. If the indicator does not send a gross, the decks are added up
instead.

## Multiple sites (9.2.0)
Settings → **Site Code** (`hillside`, `primecoal`). Every ticket is now tagged
with it, and carries a row id generated on this PC when the truck drives on.

Ticket numbers repeat across sites — both count from 001 — so the row id is
what the cloud keys on. It also makes a re-send after a dropped connection
update the same row instead of creating a second ticket. Existing tickets are
tagged automatically on first launch.

Set the Site Code before the backend is switched to per-site access, or this
PC's uploads will be rejected. Database scripts and the order of operations are
in `sql/RUNBOOK.md`.

## Cloud tab (9.3.0)
Master-only tab. Connects this weighbridge to Supabase without opening the SQL
editor twice.

**Once per Supabase project:** Cloud tab → *Copy setup SQL* → paste into the
Supabase SQL editor → put your own email on the line marked ADMIN → run.
This is unavoidable: a publishable key is not allowed to create tables, which
is exactly why it is safe to ship inside the app.

**After that, everything is buttons:**
- *Check backend* — reads what exists and shows a tick-list, including which
  `user_sites` columns this project uses. No more reading query output.
- *Set up / repair backend* — adds the columns, indexes and access rules.
  Idempotent, never deletes a ticket.
- *Register site* — links a login to a site by email, so you never copy a UUID.

**Per weighbridge PC:** project URL, publishable key, the PC's own login, and
the Site Code from Settings. *Test connection* confirms the login is registered
for the site this PC is set to — the mismatch that would otherwise lock it out
silently.

Never paste an `sb_secret_` / service_role key here. It bypasses every access
rule and the renderer is a plain HTML file anyone can open.

## Branding
All company details live in one object, `ISS_CO`, at the top of the config block
in `renderer/index.html`. Per-client white-labelling is done with a signed brand
pack (`iss-brand.json`) — packs signed with the old key still validate.

## Version
Bump `"version"` in package.json before each push so builds are easy to tell apart.
