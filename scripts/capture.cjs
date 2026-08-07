/**
 * Photograph the real app.
 *
 * Runs `out/main/index.js` — the actual entry point, window config and IPC handlers —
 * exactly as `smoke.cjs` does, for the same reason: a screenshot of a harness is a
 * screenshot of the harness, not the product.
 *
 * Seeds the app's settings first so the window has something in it. The saved-variables
 * tree comes from `seed-savedvariables.cjs`; a real WoW install works just as well if you
 * point --install at it.
 *
 * Usage:
 *   node scripts/capture.cjs out.png [--install <wowFolder>] [--fresh]
 *
 *   --fresh   clear settings first, to capture the first-run setup state
 */
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, readdirSync, statSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const entry = join(root, 'out', 'main', 'index.js');

const args = process.argv.slice(2);
const outPath = resolve(args[0] || join(root, 'capture.png'));
const fresh = args.includes('--fresh');
const installIndex = args.indexOf('--install');
const install = installIndex >= 0 ? args[installIndex + 1] : join(tmpdir(), 'raidify-demo-wow');

if (!existsSync(entry)) {
  console.error(`CAPTURE FAIL: ${entry} does not exist — run npm run build first.`);
  process.exit(1);
}

/** Same staleness guard as smoke: never photograph yesterday's build. */
function newestMtime(dir) {
  let newest = 0;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    newest = Math.max(newest, item.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}
if (newestMtime(join(root, 'src')) > statSync(entry).mtimeMs) {
  console.error('CAPTURE FAIL: out/ is older than src/ — run npm run build.');
  process.exit(1);
}

/**
 * Build the settings the app should start with.
 *
 * Handed over by env var and written by the APP, not here: run unpackaged, Electron's
 * userData is %APPDATA%/Electron rather than the product name, so writing settings.json
 * "where the app keeps it" put it somewhere the app never looked and the capture showed an
 * unconfigured app with a valid token.
 */
function settingsFor(guild) {
  const sv = join(install, '_anniversary_', 'WTF', 'Account', 'DEMO#1', 'SavedVariables');
  return {
    guildId: guild?.id ?? null,
    guildName: guild?.name ?? null,
    savedVariablesPath: join(sv, 'Raidify.lua'),
    lootSavedVariablesPath: join(sv, 'Raidify_Loot.lua'),
    installPath: install,
    autoWatch: true,
  };
}

mkdirSync(dirname(outPath), { recursive: true });

/*
 * Ask the local API for a companion token so the capture shows the signed-in app rather
 * than the setup panel. Optional: without a running API this just skips, and the capture
 * still works — it will simply show the first-run state.
 *
 * The token is handed to the app by env var because `safeStorage` only works inside a
 * running Electron process; the app stores it through the same function real sign-in uses.
 */
async function mintToken() {
  if (fresh) return null;
  try {
    const res = await fetch('http://localhost:5001/api/v1/dev/companion-token', { method: 'POST' });
    if (!res.ok) {
      console.log(`no companion token (${res.status}) — capturing signed-out`);
      return null;
    }
    const body = await res.json();
    console.log('minted a companion token for the demo founder');
    return body.token;
  } catch {
    console.log('API not reachable — capturing signed-out');
    return null;
  }
}

/**
 * Which guild the token can actually report for.
 *
 * The placeholder id written above matches nothing, so the guild step renders as
 * unanswered — asking the server is the difference between a capture of a finished setup
 * and a capture of a half-finished one.
 */
async function realGuild(token) {
  if (!token) return null;
  try {
    const res = await fetch('http://localhost:5001/api/v1/companion/guilds', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const guilds = await res.json();
    return guilds[0] ?? null;
  } catch {
    return null;
  }
}

void (async () => {
  const token = await mintToken();
  const guild = fresh ? null : await realGuild(token);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron');
  const binary = typeof electron === 'string' ? electron : String(electron);

  /*
   * Point the app at the local API.
   *
   * It defaults to production, so without this the capture signed in with a token minted
   * locally and then asked api.raidify.app to validate it — a 401, rendered as "couldn't
   * reach Raidify to load your guilds", which looks like a network problem and is not one.
   */
  const env = {
    ...process.env,
    RAIDIFY_CAPTURE: outPath,
    RAIDIFY_API_URL: process.env.RAIDIFY_API_URL ?? 'http://localhost:5001',
    RAIDIFY_WEB_URL: process.env.RAIDIFY_WEB_URL ?? 'http://localhost:5173',
  };
  if (token) env.RAIDIFY_CAPTURE_TOKEN = token;
  if (fresh) {
    // Cleared by the app, for the same reason it writes them: only it knows where they are.
    env.RAIDIFY_CAPTURE_FRESH = '1';
    console.log('capturing first-run state (settings + credentials cleared)');
  } else {
    env.RAIDIFY_CAPTURE_SETTINGS = JSON.stringify(settingsFor(guild));
    console.log(`seeding settings (guild: ${guild?.name ?? 'none'})`);
  }

  const child = spawn(binary, [entry], { env, stdio: 'inherit' });

  const timer = setTimeout(() => {
    console.error('CAPTURE FAIL: the app did not report within 60s.');
    child.kill();
    process.exit(1);
  }, 60_000);

  child.on('exit', (code) => {
    clearTimeout(timer);
    process.exit(code ?? 1);
  });
})();
