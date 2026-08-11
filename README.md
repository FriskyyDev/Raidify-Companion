# Raidify Companion

Watches the Raidify addon's saved variables and uploads a finished raid night's
attendance, so nobody has to paste an export string on a Tuesday.

Windows, unsigned, per-user install. It updates itself from the releases on this repo.

**What it touches**, so you do not have to take our word for it: it reads
`Raidify.lua` and `Raidify_Loot.lua` from your WoW SavedVariables folder, and talks to
`api.raidify.app`. Nothing else. Process Monitor and Fiddler will confirm both in about
ten minutes, and we would rather you checked than trusted.

The sign-in token it stores is encrypted with the OS credential store and can only upload
for guilds you already manage. Revoke it any time from the web app.

Plan of record: `docs/COMPANION_APP_PLAN.md` in the `raidify` repo.

---

## Decisions you would otherwise have to re-derive

| | | Why |
|---|---|---|
| **Electron** | not .NET/Avalonia, not Tauri | v0 has a real, guiding UI, and a UI that should look like raidify.app is an argument for React specifically. Reuses the web's Tailwind tokens |
| **Windows only** | macOS and Linux dropped | Gatekeeper refuses unsigned bundles outright, so macOS is $99/yr or nothing; Linux went with it since every distributed platform is a support surface. Electron still compiles both from this source |
| **32-bit (`ia32`)** | matching the WCL Uploader | Costs nothing, removes a class of "it won't run" reports |
| **Unsigned** | signing hook stubbed, not wired | $120/yr against a free feature with no revenue. SmartScreen is two clicks for an audience that installs addons by unzipping folders |
| **No native modules** | `wasmoon`, `safeStorage`, Node stdlib | The WCL Uploader ships zero `.node` files. Native modules mean per-platform rebuilds, per-platform breakage, and extra antivirus interest in an unsigned binary |
| **Updates via GitHub releases** | `electron-updater` | Free CDN, no bucket, no manifest hosting |
| **Types hand-written** | `src/shared/contract.ts` | Two endpoints. `npm run schema:pull` refreshes the reference OpenAPI document so a contract change is a diff to review |

**Re-open signing** when any of these happens: a real antivirus false positive lands on
users, revenue makes $120/yr trivial, or funnel data shows people abandoning at the
warning. The research is kept in `COMPANION_APP_PLAN.md` §4a so acting on it is an
afternoon.

---

## Layout

```
src/
  main/                  Everything that touches disk, network or a credential
    api.ts                 The only two calls that leave this machine
    lua.ts                 Sandboxed Lua evaluation — and `toArray`, see below
    savedVariables.ts      RaidifyDB.lua → a night, with .bak fallback
    discovery.ts           Finding the install, the flavour and the account
    watcher.ts             One flush → one read, debounced and size-stable
    secrets.ts             Token at rest, via safeStorage
  preload/               The named IPC surface — not a generic invoke passthrough
  renderer/              React + Tailwind. No Node access
  shared/                The API contract and the IPC types
fixtures/wow/            A real WTF tree the tests read
```

## Commands

```bash
npm install
npm run dev        # electron-vite, hot reload
npm test           # vitest
npm run typecheck
npm run smoke      # starts the real app, asserts the bridge works and the window drew
npm run package    # unsigned installer into dist/
```

Point at a local API with `RAIDIFY_API_URL=http://localhost:5001 npm run dev`.

### Running against a real API

`src/main/live.test.ts` signs in for real, exchanges a code for a token, lists guilds and
uploads a night. It skips unless pointed at an API, because a suite that needs a database
running is a suite people stop running.

```bash
# in the raidify repo
docker compose up -d
dotnet run --project apps/api/src/Raidify.Api --urls http://localhost:5001

# here
RAIDIFY_E2E_API_URL=http://localhost:5001 npm test
```

Needs `AllowTestLogin`, which `appsettings.Development.json` already sets. It cannot run
against production — test-login 404s there and the first step fails loudly rather than
quietly touching real data.

Worth running after any change to `src/shared/contract.ts`. Every other test in this repo
can pass while the app cannot sign in; this is the one that would notice. It found the
204 sign-out bug on its first run.

### Refreshing the API reference

`npm run schema:pull [baseUrl]` rewrites `reference/openapi.json`, then read the diff.

It keeps only the eight companion endpoints and the schemas they reach — 14 of the API's
328. The full document is a complete map of the private API, and this repo may be made
public so anyone wary of an unsigned binary can read what it does.

## Releasing

Tag `v*`. CI typechecks, tests, packages, publishes the installer and `latest.yml` to a
GitHub release, and attaches `SHA256SUMS.txt`.

The download page promises a checksum and an explanation of the SmartScreen warning —
an unexplained wall reads as malware, an explained one reads as a small project.

## Traps worth knowing before you touch the parser

**`toArray` is not optional.** wasmoon returns a Lua `1..n` table as *either* a JS array
or an object keyed `"1".."n"`, depending on the table's size — measured with 1.16:
1–2 array, 3–4 object, 5–6 array, 7–8 object, 9 array, 40 array. That follows Lua's
internal array/hash split. A five-man roster and a seven-man roster parse to different
types, so a fixture small enough to be convenient hides the bug and a real raid finds it.
Always go through `toArray` (`src/main/lua.ts`), which is pinned by a test.

**The bucketing is duplicated.** `bucketNight` in `src/main/savedVariables.ts` mirrors
`Raidify:GetAttendanceData()` in the addon's `Attendance.lua` — same grace period, same
status codes, computed from disk instead of live game state. Two implementations of one
rule drift. The durable fix is for the addon to persist the bucketed result when a
session ends; do that before the rules get more interesting than late and left-early.

**A session without a roster is refused, not uploaded.** Without the roster the addon
only knows who it *saw*, so uploading would silently turn every no-show into nothing.

## Not built yet

**The Lua parse runs on the main process.** A forty-man file parses fast enough that
nobody notices, but it is still the UI thread doing it, and the file only grows.

**Nothing is uploaded automatically.** Deliberate for now — see `NightCard.tsx` for why
the officer is the one who decides a session was the guild's raid. An "always send
finished nights for this guild" setting is reasonable once the matching has earned trust.

## Where the sign-in is kept

`safeStorage` — DPAPI on Windows, Keychain on macOS, libsecret or KWallet on Linux. When
no real store is available the token is not written at all; the officer signs in each
launch instead.

The Linux case is the one worth stating. With no keyring daemon running, Electron falls
back to a backend named `basic_text` that scrambles with a key hardcoded in Chromium —
recoverable by anyone who can read the file — and `isEncryptionAvailable()` still answers
**true** for it. So availability alone is not the check: on Linux the selected backend is
read as well, `basic_text` counts as no store, and a credentials file left by an earlier
build that trusted the flag is deleted on the next launch rather than left lying around.
The setup panel says which daemon to start.
