# Raidify Companion

Watches the Raidify addon's saved variables and uploads a finished raid night's
attendance, so nobody has to paste an export string on a Tuesday.

**Private until announcement.** A public repo named `Raidify-Companion` announces the
feature as loudly as a blog post, and the no-pre-announcement rule is binding. Going
public is a post-announcement decision.

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
  main/        Everything that touches disk, network or a credential
    api.ts       The only two calls that leave this machine
    lua.ts       Sandboxed Lua evaluation of RaidifyDB.lua
    secrets.ts   Token at rest, via safeStorage
  preload/     The named IPC surface — not a generic invoke passthrough
  renderer/    React + Tailwind. No Node access
  shared/      The API contract, mirrored from CompanionDtos.cs
```

## Commands

```bash
npm install
npm run dev        # electron-vite, hot reload
npm test           # vitest
npm run typecheck
npm run package    # unsigned installer into dist/
```

Point at a local API with `RAIDIFY_API_URL=http://localhost:5001 npm run dev`.

## Releasing

Tag `v*`. CI typechecks, tests, packages, publishes the installer and `latest.yml` to a
GitHub release, and attaches `SHA256SUMS.txt`.

The download page promises a checksum and an explanation of the SmartScreen warning —
an unexplained wall reads as malware, an explained one reads as a small project.

## Not built yet

Step 3 of the plan's sequence: WoW install discovery, the file watcher (debounce plus a
size-stable check — WoW writes SavedVariables by rename and a poll can catch it
mid-write), `.lua.bak` fallback, the account/flavour picker, and the sign-in flow proper.
`src/main/index.ts` has the IPC shape for sign-in already so the boundary is visible.
