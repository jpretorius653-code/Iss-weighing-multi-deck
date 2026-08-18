# Build notes

## The installer activation gate is OFF by default
An earlier build failed on `electron/installer.nsh` (the "Invalid command: ${If}"
error). To guarantee the build succeeds, the installer code-prompt is disabled.

**You lose nothing:** the app still asks for the activation code **ISS2025** the
first time it runs.

### To turn the installer code-prompt back ON later (optional)
1. Confirm the app builds cleanly first (green tick in Actions).
2. In `package.json`, inside `"build" > "nsis"`, add this line back:
       "include": "electron/installer.nsh",
3. Push. If that build goes green, the installer now asks for ISS2025 before
   installing. If it goes red again, remove the line — the app-level gate is enough.

## Toolchain (updated with this release)
| Package         | Was      | Now       | Why |
|-----------------|----------|-----------|-----|
| electron        | ^31.0.0  | ^41.10.4  | 31 is past end-of-life (no Chromium security fixes). 41 is the most settled of the currently supported lines. |
| electron-builder| ^24.13.3 | ^26.15.3  | Needed for modern Electron; better NSIS handling. |
| serialport      | ^12.0.0  | ^13.0.0   | Current major; prebuilds for current Node/Electron ABIs. |
| CI Node         | 20       | 22        | serialport 13 requires Node >= 20; 22 is LTS. |

`postinstall: electron-builder install-app-deps` was added so the serialport
native binary is always rebuilt against the Electron ABI in use. This is the
usual cause of "native serial: NOT loaded — using Web Serial fallback".

### If the native rebuild fails on the runner
Fall back one step at a time, rebuilding after each:
1. `electron` → `^38.8.6`
2. `electron` → `^37.10.3`
3. Last resort: back to `^31.0.0` + `electron-builder ^24.13.3` + `serialport ^12.0.0`
   (the exact combination that was known-green before this update).

Verify with: app menu → **Help → Serial Diagnostics…** → must read
"Native serial: ACTIVE".

## Data migration across the rebrand
Electron derives its data folder from `productName`, so renaming the app to
"ISS Weighbridge" moves it. `electron/storage.js` now adopts, on first launch,
both the config **and** the state file from any previous product name
(Hillside Complex Weighbridge, Hillside Weighbridge, NovaSpire Weighbridge,
A AND N KADIR Weighbridge) and from the old filenames
(`novaspire-config.json`, `hillside-state.json`).

Without this, every deployed site would have launched looking like a fresh
install — no activation, no users, no database, no paired COM ports. It copies
rather than moves, only when the destination is missing, and skips unparseable
files, so it cannot destroy live data.

Backups are now written as `ISS-Backup-<date>.json`; rotation still recognises
the older `Hillside-Backup-*` / `NovaSpire-Backup-*` files so the 30-day cap
keeps working on existing PCs.

## Version stamping (RENDERER_BUILD)
`renderer/index.html` carries a build stamp that CI checks against
`package.json`:

    const RENDERER_BUILD='9.0.0';

It sits at the top of the main `<script>` block (immediately before the debug
console). The format matters — no spaces around `=`, single quotes, one line —
because the workflow greps for it. **Bump both numbers together** or the build
fails with "Version mismatch".

To bump, one command:

    npm version 9.0.1 --no-git-tag-version && \
    sed -i "s/const RENDERER_BUILD='[^']*'/const RENDERER_BUILD='9.0.1'/" renderer/index.html

Better long-term: have CI *inject* the version instead of asserting it — replace
the guard step with a step that writes package.json's version into the constant
before `npm run dist`. Then there is only one number to bump, and the two can
never drift.

The build number is logged to the in-app debug console (Settings → Diagnostics,
or Ctrl+Alt+D) on every launch, so a site can be identified over the phone.

## Why there is no package-lock.json
`actions/setup-node` with `cache: npm` refuses to run without a committed
lockfile ("Dependencies lock file is not found"), so the cache line is left out
of the workflow and CI runs a plain `npm install`. That is how this repo has
always built.

If you want the ~30 s of cache back, add a lockfile — but generate it **on the
Windows machine you build from**, not on Linux, so platform-specific optional
dependencies are recorded:

    npm install --package-lock-only
    git add package-lock.json

then in `.github/workflows/build.yml`:
- put `cache: npm` back under `Setup Node`
- change `npm install` to `npm ci`

Re-run the lockfile command any time you change a dependency, or `npm ci` will
fail with "lock file out of sync".

## Multi-deck (9.1.0)
Per-bridge `deckMode` / `deckCount` / `deckMap` / `deckTol` in config. One
tokeniser (`numTokens`) now feeds both the field mapper and the parser, so the
field number shown in Settings is always the field the parser reads.

`parseRaw` was rewired onto that tokeniser and was checked against the original
implementation across 26 strings — identical output on every one, including
Toledo frames, thousands separators, negatives, space-padded readings and
manual position mode. Single-deck bridges are unaffected.

Known, pre-existing, left alone: the token regex allows spaces inside a number
(`1 2345` -> 12345) because some indicators pad that way. A side effect is that
`02 14280` reads as 214280. Changing it would break the space-padded indicators
it was written for, so it stands — but if a bridge ever reads a wildly inflated
weight, this is the first thing to check.

The gross cannot be told apart from a deck when only one deck is loaded — both
carry the same number. Suggest and Learn both refuse rather than guess, and say
what to do instead.

## Everything else is unchanged and verified
- All JS syntax-checks (`node --check` on every file in electron/, both renderer
  script blocks parsed)
- All internal paths resolve
- serialport native module builds on the GitHub Windows runner
