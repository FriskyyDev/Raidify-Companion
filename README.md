# Raidify Companion

A small Windows app that uploads your raid night's attendance to
[Raidify](https://www.raidify.app), so nobody has to copy an export string out of the game
at the end of a raid.

You do not need it. The Raidify addon exports a string and the website accepts it. This
exists because the last step of a raid night is the one that gets forgotten, and a record
nobody uploaded is not a record.

## What it touches

You should not have to take our word for this, so it is short enough to check.

It reads two files, both written by the Raidify addons, both inside your World of Warcraft
folder:

- `WTF/Account/<account>/SavedVariables/Raidify.lua` — the attendance session
- `WTF/Account/<account>/SavedVariables/Raidify_Loot.lua` — loot sessions, if you run that addon

It talks to one host, `api.raidify.app`. That is the whole list. Process Monitor will show
you the files and Fiddler will show you the traffic, in about ten minutes, and we would
rather you checked than trusted.

To find those two files it lists the account folders under `WTF/Account`, which is how it
works out which account you play on. It opens nothing else: not your other addons, not your
settings, nothing outside the World of Warcraft folder you chose.

It never touches the game itself. The only time there is anything new to read is after you
log out, because that is when the game writes the file.

## Installing

Download the installer from the
[latest release](https://github.com/FriskyyDev/Raidify-Companion/releases/latest).

It installs for your user only and does not ask for administrator rights.

**Windows will warn you.** The installer is not code-signed, so SmartScreen shows "Windows
protected your PC". Click **More info**, then **Run anyway**. That warning means the
publisher has not paid for a certificate, not that the file is known to be harmful — but you
should not take that on faith either, which is what the checksum below is for.

Every release publishes `SHA256SUMS.txt`. To check the file you downloaded matches the file
we published:

```powershell
Get-FileHash .\raidify-companion-v0.1.0.exe -Algorithm SHA256
```

Compare it against the line in `SHA256SUMS.txt` on the release page. That proves the
download was not corrupted or tampered with in transit. It does not, on its own, prove
anything about our intentions — the source in this repository is there for that.

The app updates itself from this repository's releases.

## Using it

1. Install it and sign in with Discord. It opens your browser, you approve, it comes back.
2. Pick your guild, and confirm the World of Warcraft folder it found.
3. Raid. Type `/rf end` in game when you finish, then log out — the game writes the file on
   logout, not before.
4. The night appears in the app. Press **Send**.

Leave it running. It is built to sit there for weeks and notice when a new night appears.

Every night can be checked before it is sent: the dry run reports exactly what would be
recorded and writes nothing. Worth doing the first few times, until you trust what it reads.

Sending the same night twice is safe. Each one carries an id, so a second send updates
rather than duplicating.

## Where your sign-in is kept

The token is encrypted with the operating system's own credential store — DPAPI on Windows.
It can only upload for guilds you already manage, and you can revoke it at any time from
your account settings on the website.

When no real credential store is available, the token is not written to disk at all and you
sign in each launch instead. That case is mostly Linux, where a missing keyring daemon makes
Electron fall back to a backend that scrambles with a key hardcoded in Chromium — recoverable
by anyone who can read the file — while still reporting that encryption is available. So the
app checks which backend was actually selected rather than trusting that answer, and deletes
any credentials file an earlier build left behind.

## Something wrong?

Use **Send a report** in the app. It attaches the recent log, with your sign-in token and
your Windows folder names removed, and shows you the whole thing before it sends. There is a
free-text box for what you were doing, which is usually more useful than the log.

You can also copy the report and bring it to the Raidify Discord, or open the log folder from
the same panel and read it yourself.

---

## Building from source

Requires Node 22.

```bash
npm install
npm run dev        # electron-vite, hot reload
npm test           # vitest
npm run typecheck
npm run smoke      # starts the real app and asserts the window drew and the IPC bridge works
npm run package    # unsigned installer into dist/
```

Point it at a different API with `RAIDIFY_API_URL=http://localhost:5001 npm run dev`. Those
development hooks only work in an unpackaged build; a released one ignores them.

The Raidify API and the in-game addon are separate projects and are not open source, so the
end-to-end test in `src/main/live.test.ts` skips unless you point it at an API you can run.

### Layout

```
src/
  main/                  Everything that touches disk, network or a credential
    api.ts                 Every call that leaves this machine, and there are seven
    lua.ts                 Sandboxed Lua evaluation, and toArray — see the note below
    savedVariables.ts      Raidify.lua to a night, with .bak fallback
    discovery.ts           Finding the install, the flavour and the account
    watcher.ts             One flush, one read, debounced and size-stable
    secrets.ts             The token at rest, via safeStorage
    diagnostics.ts         The local log, and the redaction applied before it is shared
  preload/               A named IPC surface, not a generic invoke passthrough
  renderer/              React and Tailwind. No Node access at all
  shared/                The API contract and the IPC types
fixtures/wow/            A real WTF tree the tests read
reference/               The companion's corner of the API, as OpenAPI
```

`reference/openapi.json` describes only the eight endpoints this app calls, and the 14
schemas they reach. `npm run schema:pull` regenerates it so a contract change shows up as a
diff worth reviewing.

### How it is built, and why

| | |
|---|---|
| **Electron** | The app has a real guiding UI that should look like the website, which is an argument for React specifically |
| **Windows only** | macOS refuses unsigned bundles outright, and every additional platform is a support surface. The source still compiles for all three |
| **32-bit** | Costs nothing and removes a class of "it will not run" reports |
| **Unsigned** | A certificate is a running cost against a free feature. It is worth revisiting the first time antivirus flags a build |
| **No native modules** | Native modules mean per-platform rebuilds, per-platform breakage, and extra antivirus interest in an unsigned binary |
| **Updates from GitHub releases** | Free, and no manifest hosting to run |
| **Types written by hand** | A handful of endpoints is not worth a generator |

### Notes for anyone reading the parser

**`toArray` is not optional.** wasmoon returns a Lua `1..n` table as *either* a JS array or
an object keyed `"1".."n"`, depending on the table's size — measured with 1.16: 1–2 array,
3–4 object, 5–6 array, 7–8 object, 9 array, 40 array. That follows Lua's internal array and
hash split. A five-man roster and a seven-man roster parse to different types, so a fixture
small enough to be convenient hides the bug and a real raid finds it. Always go through
`toArray` in `src/main/lua.ts`, which a test pins.

**The bucketing is duplicated.** `bucketNight` in `src/main/savedVariables.ts` mirrors the
addon's own attendance logic — the same grace period and the same status codes, computed
from a file instead of from live game state. Two implementations of one rule drift, and this
pair already did once: an unfinished session used to be recorded as everybody leaving early.

**A session without a roster is refused rather than uploaded.** Without the roster the addon
only knows who it *saw*, so uploading it would silently turn every no-show into nothing.

**Nothing uploads on its own.** A person decides that a session was the guild's raid night,
because the app cannot tell a raid from an alt run that happened to have twenty people in it.
