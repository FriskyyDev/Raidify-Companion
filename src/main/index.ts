import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { ApiClient } from './api';
import { buildAuthorizeUrl, createPkcePair, LoopbackReceiver } from './auth';
import { autoDetect, findSavedVariables } from './discovery';
import { canPersist, clearToken, loadToken, saveToken } from './secrets';
import { readNights } from './savedVariables';
import type { ParsedNight, SavedVariablesCandidate } from '../shared/types';
import { SavedVariablesWatcher } from './watcher';
import { evaluateCompat, type CompatVerdict } from '../shared/contract';

/**
 * Main process.
 *
 * Everything that touches the disk, the network or a credential happens here. The
 * renderer gets a narrow, named surface over IPC (see `src/preload`) and no Node access
 * at all — it is a UI, and a UI that can read arbitrary files is a liability in an app
 * whose whole job is reading one specific file.
 */

/**
 * Our version, not Electron's.
 *
 * `app.getVersion()` returns the Electron runtime's version when running unpackaged, so
 * in development the app reported v43 and sailed past any minimum-client check the
 * server could state — the compat gate was untestable precisely where you would test it.
 */
const CLIENT_VERSION: string = app.isPackaged
  ? app.getVersion()
  : ((): string => {
      try {
        return require('../../package.json').version as string;
      } catch {
        return app.getVersion();
      }
    })();
const API_BASE_URL = process.env.RAIDIFY_API_URL ?? undefined;

let window: BrowserWindow | null = null;
let watcher: SavedVariablesWatcher | null = null;

/** Tell the UI something happened, if it is there to hear it. */
function emit(channel: string, payload: unknown): void {
  // A read in flight when the officer closes the window would otherwise throw here,
  // inside a catch block, and become an unhandled rejection in the main process.
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

/**
 * Hand a URL to the OS, but only if it is a web link.
 *
 * `shell.openExternal` passes the string to the Windows shell, which happily accepts
 * `file:`, UNC paths and registered handlers like `search-ms:` — several of which have
 * been code-execution primitives. Unrestricted, this is the single line that turns "an
 * attacker can render markup in the renderer" into "an attacker can launch a program".
 */
function openExternally(url: string): void {
  if (/^https:\/\//i.test(url)) void shell.openExternal(url);
}

const api = new ApiClient({
  baseUrl: API_BASE_URL,
  clientVersion: CLIENT_VERSION,
  getToken: async () => loadToken(),
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#191c22',
    webPreferences: {
      // .cjs, and it must stay that way: a sandboxed preload is not an ES module, and
      // electron.vite.config.ts forces CommonJS output to match. Getting this filename
      // wrong does not throw anywhere visible — the preload simply fails to load,
      // `window.companion` is undefined, and the window renders its shell and then does
      // nothing forever, while packaging still succeeds. That shipped once. `npm run
      // smoke` and src/main/build.test.ts exist to make sure it cannot ship again.
      preload: join(__dirname, '../preload/index.cjs'),
      // The preload uses only contextBridge and ipcRenderer, both of which work
      // sandboxed. Leaving it off meant any renderer-side flaw ran as the user with no
      // escape required — a free defence being declined.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.on('ready-to-show', () => {
    // Smoke mode: prove the renderer can actually reach the app, then leave.
    //
    // This lives in the real main process rather than a test harness that mirrors it,
    // because the bug it guards against WAS a mismatch between the real config and what
    // the build emitted — a mirror would have drifted the same way and reported success.
    // Ten lines behind an env var, in exchange for the one check that would have caught
    // shipping an app that could not do anything.
    if (process.env.RAIDIFY_SMOKE === '1') {
      void runSmokeCheck(window!);
      return;
    }

    window?.show();
  });
  window.on('closed', () => {
    window = null;
  });

  // Nothing in this app should ever open a second window, and a link that tries is
  // either a mistake or something worse. Send them to the real browser instead —
  // but only if it is a web link.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });

  // setWindowOpenHandler covers window.open and target=_blank; it does NOT cover
  // top-level navigation via location.href. Without this, a renderer flaw could point
  // the window at a remote origin, which would then inherit `window.companion` and
  // shed the CSP along with the local document.
  window.webContents.on('will-navigate', (event, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL;
    if (dev && url.startsWith(dev)) return;
    event.preventDefault();
    openExternally(url);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Assert the bridge exists and that IPC round-trips, then exit.
 *
 * Checks a real `invoke` rather than just the presence of functions: a preload that
 * loads but whose handlers are missing looks identical from the renderer until something
 * is called.
 */
async function runSmokeCheck(target: BrowserWindow): Promise<void> {
  const expected = [
    'appInfo', 'checkCompat', 'authStatus', 'signOut', 'signIn',
    'detectInstalls', 'browseForInstall', 'readNights', 'watch', 'unwatch',
    'onNights', 'onWatchError',
  ];

  try {
    const report = await target.webContents.executeJavaScript(
      `(async () => {
         const bridge = window.companion;
         if (!bridge) return { ok: false, reason: 'window.companion is undefined' };
         const missing = ${JSON.stringify(expected)}.filter((n) => typeof bridge[n] !== 'function');
         if (missing.length) return { ok: false, reason: 'missing: ' + missing.join(', ') };
         const info = await bridge.appInfo();
         if (!info || typeof info.version !== 'string') return { ok: false, reason: 'appInfo did not round-trip' };
         return { ok: true, version: info.version };
       })()`,
    );

    if (!report?.ok) {
      console.error(`SMOKE FAIL: ${report?.reason ?? 'unknown'}`);
      app.exit(1);
      return;
    }

    console.log(`SMOKE OK: bridge exposes ${expected.length} calls, appInfo returned v${report.version}`);
    app.exit(0);
  } catch (error) {
    console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────────
//
// One handler per thing the UI is allowed to ask for. No generic "call the API" bridge:
// the point of the boundary is that the list of possible requests is readable.

ipcMain.handle('app:info', () => ({
  version: CLIENT_VERSION,
  canRememberSignIn: canPersist(),
  platform: process.platform,
}));

ipcMain.handle('compat:check', async (): Promise<CompatVerdict> => {
  try {
    const compat = await api.compat();
    return evaluateCompat(compat, CLIENT_VERSION);
  } catch (error) {
    // Offline is a normal state for this app — the officer's machine sleeps, the
    // network drops mid-raid. Report it as a condition, not a crash.
    return { kind: 'unreachable', error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('auth:status', () => ({ signedIn: loadToken() !== null }));
ipcMain.handle('auth:signOut', async () => {
  // Revoke server-side first, while we still hold the credential. If the network is
  // down we still clear locally — the officer asked to sign out and must not be stuck
  // signed in — but then the token lives until it expires, which is why it now does.
  try {
    await api.signOut();
  } catch {
    /* offline, or already revoked from the web. Clearing locally either way. */
  }

  clearToken();
  return { signedIn: false };
});

/**
 * Sign in. No code to type: the officer's own browser, one click, done.
 *
 * The verifier stays in this process for the whole flow — it is never put in the URL,
 * so the code that travels back through the browser is worthless to anyone who sees it.
 */
ipcMain.handle('auth:signIn', async () => {
  const { verifier, challenge } = createPkcePair();
  const receiver = new LoopbackReceiver();

  try {
    const { port, code } = await receiver.listen();

    await shell.openExternal(
      buildAuthorizeUrl(API_BASE_URL ?? 'https://www.raidify.app', {
        challenge,
        port,
        state: receiver.state,
      }),
    );

    const result = await code;
    const exchanged = await api.exchangeCode(result.code, verifier);
    saveToken(exchanged.token);
    return { signedIn: true, label: exchanged.label };
  } finally {
    // Belt and braces: the receiver closes itself on every path it knows about, but a
    // listening socket left behind by an unexpected throw is a port held for the life of
    // the process.
    receiver.close();
  }
});

// ── the install, and the file ───────────────────────────────────────────────────

ipcMain.handle('wow:autoDetect', async (): Promise<SavedVariablesCandidate[]> =>
  remember(await autoDetect()),
);

/**
 * Let the officer point at the folder themselves.
 *
 * Auto-detection is a convenience and never the last word — people move installs, run
 * two of them, and keep an old one around.
 */
ipcMain.handle('wow:browse', async (): Promise<SavedVariablesCandidate[]> => {
  if (!window) return [];
  const result = await dialog.showOpenDialog(window, {
    title: 'Find your World of Warcraft folder',
    properties: ['openDirectory'],
  });
  const chosen = result.filePaths[0];
  return result.canceled || !chosen ? [] : remember(await findSavedVariables(chosen));
});

/**
 * Paths the renderer is allowed to name.
 *
 * Only ones this process discovered itself, via auto-detect or the folder picker. The
 * renderer previously passed any absolute path straight through to a file read and a Lua
 * evaluation — an arbitrary-file-read-and-parse primitive handed to the least trusted
 * part of the app, for no reason: it only ever names paths we just gave it.
 */
const discovered = new Set<string>();

function remember(candidates: SavedVariablesCandidate[]): SavedVariablesCandidate[] {
  for (const candidate of candidates) discovered.add(candidate.path);
  return candidates;
}

function requireDiscovered(path: unknown): string {
  if (typeof path !== 'string' || !path) throw new Error('No saved-variables path supplied.');
  if (!discovered.has(path)) {
    throw new Error('That file was not one of the saved-variables files this app found.');
  }
  return path;
}

/** Read whatever is on disk right now, without waiting for the game to flush. */
ipcMain.handle('wow:read', (_event, path: unknown): Promise<ParsedNight[]> =>
  readNights(requireDiscovered(path)),
);

/**
 * Start watching. One watcher at a time — a second one would double every upload, and
 * two watchers racing on the same file is the kind of bug that only shows up on a night
 * that matters.
 */
ipcMain.handle('wow:watch', async (_event, rawPath: unknown) => {
  const path = requireDiscovered(rawPath);

  watcher?.stop();
  watcher = new SavedVariablesWatcher(
    { path },
    {
      onNights: (nights) => emit('wow:nights', nights),
      onError: (error) => emit('wow:error', { message: error.message }),
    },
  );
  watcher.start();

  // Read once immediately: the interesting flush may already have happened while the
  // app was closed, and a companion that only notices future raids is half a companion.
  await watcher.readNow();
  return { watching: true, path };
});

ipcMain.handle('wow:unwatch', () => {
  watcher?.stop();
  watcher = null;
  return { watching: false };
});

// ── lifecycle ───────────────────────────────────────────────────────────────────

// One officer, one companion. A second copy watching the same file would upload the
// same night twice and race the first one doing it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    watcher?.stop();
    app.quit();
  });
}
