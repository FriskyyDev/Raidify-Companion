import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
/*
 * electron-updater is CommonJS, and this package is `"type": "module"`.
 *
 * A named import compiles fine and then throws at runtime — Node cannot statically resolve
 * named bindings from a CJS module, so the app died during startup with "does not provide an
 * export named 'autoUpdater'" and never reached the point where it reports ready. The smoke
 * test caught it; nothing before the smoke test could, because typecheck and bundling both
 * succeed.
 *
 * Default-import the module object, then destructure. This is exactly what the runtime error
 * suggests, and it is the documented interop for this package.
 */
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import { ApiClient } from './api';
import { buildAuthorizeUrl, createPkcePair, LoopbackReceiver } from './auth';
import { autoDetect, findSavedVariables } from './discovery';
import { canPersist, clearToken, loadToken, persistenceBlocker, saveToken } from './secrets';
import { readNights } from './savedVariables';
import { readLootExports } from './lootExports';
import { loadSettings, rememberLootUpload, rememberUpload, saveSettings } from './settings';
import { nightKey } from '../shared/nightKey';
import type {
  BrowseResult,
  ParsedNight,
  PendingLootExport,
  SavedVariablesCandidate,
  Settings,
} from '../shared/types';
import { SavedVariablesWatcher } from './watcher';
import {
  buildReport,
  captureProcessErrors,
  diagnosticsDirectory,
  initDiagnostics,
  logError,
  logInfo,
  logWarn,
} from './diagnostics';
import {
  evaluateCompat,
  type AttendanceUploadResult,
  type CompanionGuild,
  type CompatVerdict,
  type LootSessionImportResult,
} from '../shared/contract';

/*
 * Diagnostics come up before anything else in this module, because the handlers below
 * register at import time and the wrapper has to be in place before they do.
 *
 * app.getPath('userData') is valid before `ready`, so the log is open early enough to catch
 * a failure during startup — the class of failure we are least able to reproduce.
 */
initDiagnostics();
captureProcessErrors();

/*
 * Every IPC handler, wrapped once.
 *
 * Wrapping here rather than at each call site means a handler added later cannot forget to
 * log, and it catches the case that used to vanish entirely: an exception inside a handler
 * crosses the IPC boundary as a string, so the renderer showed one sentence and the stack —
 * the only part that identifies the line — was never written down anywhere.
 *
 * The error is re-thrown unchanged. This observes; it does not alter behaviour.
 */
type IpcListener = (...args: never[]) => unknown;
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = ((channel: string, listener: IpcListener) =>
  registerHandler(channel, async (...args) => {
    try {
      return await listener(...(args as unknown as never[]));
    } catch (error) {
      logError(`IPC ${channel} failed`, error);
      throw error;
    }
  })) as typeof ipcMain.handle;

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
/**
 * Two hosts, not one.
 *
 * The consent page is served by the web app on www; the JSON API is a separate origin. A
 * single shared base sent `/api/v1/...` to the SPA host, which answers unknown paths with
 * index.html — so every call died on `Unexpected token '<'` rather than saying anything
 * useful about what was wrong.
 */
const WEB_BASE_URL = process.env.RAIDIFY_WEB_URL ?? 'https://www.raidify.app';
const API_BASE_URL = process.env.RAIDIFY_API_URL ?? 'https://api.raidify.app';

let window: BrowserWindow | null = null;
let watcher: SavedVariablesWatcher | null = null;
/** Set once an update has been downloaded and only a restart stands between us and it. */
let updateReady: { version: string } | null = null;

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

/**
 * Keep this install able to update itself.
 *
 * The whole architecture leans on a server-controlled version floor —
 * `minimumClientVersion`, `payloadVersion`, an upload kill switch — as the thing that
 * makes shipping an unsigned binary to strangers defensible: if a build turns out to send
 * bad data, Raidify refuses it and tells the officer to update. That bargain only holds
 * if the officer *can*. `electron-updater` has been a dependency and the release pipeline
 * has been publishing `latest.yml` this whole time, and nothing ever imported it — so
 * pulling the lever would have bricked every install with a message and no door out.
 *
 * Deliberately quiet: it downloads in the background and tells the renderer when a
 * restart would land it. Nothing is forced, because a raid night is the worst possible
 * moment for an app to restart itself.
 */
function startUpdateChecks(): void {
  // Unpackaged builds have no update feed and electron-updater throws if asked.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  // The officer chooses the moment. Installing on quit behind their back is how an app
  // becomes something people close rather than leave open.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = { version: info.version };
    emit('update:ready', updateReady);
  });

  // Never fatal. A failed update check must not stop the app doing its actual job, and an
  // officer with no network is the ordinary case, not an error worth a dialog.
  //
  // Logged rather than swallowed, though. This used to be an empty function, which made a
  // permanently broken updater — a corrupt cache, a proxy, AV quarantine — indistinguishable
  // from a healthy one right up until the server raised its version floor and the app became
  // a brick whose only advice was to ask in Discord.
  autoUpdater.on('error', (error) => logWarn('Update check failed', error));

  void autoUpdater.checkForUpdates().catch((error: unknown) => logWarn('Update check failed', error));
  // Six hours: this app is meant to stay open for weeks.
  setInterval(
    () => void autoUpdater.checkForUpdates().catch((error: unknown) => logWarn('Update check failed', error)),
    6 * 60 * 60 * 1000,
  );
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 980,
    // Capture mode can ask for a taller window so a screenshot shows the whole app rather
    // than the top of a scroll. Ignored in normal use.
    height: Number(process.env.RAIDIFY_CAPTURE_HEIGHT) || 720,
    minWidth: 760,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#14161c',
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

    // Capture mode: render, photograph, leave.
    //
    // Same reasoning as smoke mode — this is the real main process, the real preload and
    // the real renderer, so what comes out is the app rather than a mock of it. A
    // screenshot taken any other way would be a picture of a harness.
    if (process.env.RAIDIFY_CAPTURE) {
      void runCapture(window!, process.env.RAIDIFY_CAPTURE);
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
 * Assert the bridge exists, that IPC round-trips, and that the window drew something.
 *
 * Checks a real `invoke` rather than just the presence of functions: a preload that
 * loads but whose handlers are missing looks identical from the renderer until something
 * is called. And it checks the rendered text, because a bridge can be perfect while the
 * UI throws on mount — that combination is a blank window that packages and ships.
 */
/**
 * Photograph the window and exit. Dev only, driven by `npm run capture`.
 *
 * `RAIDIFY_CAPTURE` is the output path. Waits for the renderer to settle rather than
 * sampling immediately: the app fetches guilds and reads the saved-variables file after
 * first paint, so a capture taken on `ready-to-show` catches a loading state every time.
 */
async function runCapture(target: BrowserWindow, outPath: string): Promise<void> {
  try {
    target.show();

    /*
     * Wait for the UI to stop changing, rather than for any particular string.
     *
     * The first attempt polled for a marker and broke immediately, because the marker it
     * checked for the *absence* of ("Loading your guilds") is also absent at first paint —
     * so it photographed a half-loaded app every time. This app does several async things
     * after first paint: a compat check, a guild fetch, a saved-variables read. Quiescence
     * covers all of them without naming any.
     *
     * The window is deliberately long. The UI is perfectly still WHILE it waits, and
     * reading the saved-variables file spins up a WASM Lua runtime the first time — so a
     * short quiet period is indistinguishable from being finished, and a 600ms threshold
     * reliably photographed the app just before its raid nights arrived.
     */
    await target.webContents.executeJavaScript(
      `(async () => {
         const deadline = Date.now() + 20000;
         let previous = '';
         let stableFor = 0;
         const startedAt = Date.now();
         while (Date.now() < deadline) {
           await new Promise((r) => setTimeout(r, 200));
           const now = document.body.innerText || '';
           stableFor = now === previous ? stableFor + 1 : 0;
           previous = now;
           // ~2s of stillness, and never before 3s total.
           if (stableFor >= 10 && now.length > 0 && Date.now() - startedAt > 3000) break;
         }
         await new Promise((r) => requestAnimationFrame(() => r(null)));
       })()`,
    );

    /*
     * Optionally click something before photographing.
     *
     * A capture of a screen nobody has touched only ever shows the resting state — the
     * review results, which are the point of the gate, would never appear in one.
     * `RAIDIFY_CAPTURE_CLICK` is button text to find and press, then settle again.
     */
    const clickText = process.env.RAIDIFY_CAPTURE_CLICK;
    if (clickText) {
      const clicked = await target.webContents.executeJavaScript(
        `(async () => {
           const wanted = ${JSON.stringify(clickText)};
           const hits = Array.from(document.querySelectorAll('button'))
             .filter((b) => (b.textContent || '').trim() === wanted && !b.disabled);
           hits.forEach((b) => b.click());
           await new Promise((r) => setTimeout(r, 4000));
           return hits.length;
         })()`,
      );
      console.log(`CAPTURE clicked ${clicked} x "${clickText}"`);
    }

    const image = await target.webContents.capturePage();
    await writeFile(outPath, image.toPNG());
    console.log(`CAPTURE OK: ${outPath}`);
    app.exit(0);
  } catch (error) {
    console.error(`CAPTURE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
}

async function runSmokeCheck(target: BrowserWindow): Promise<void> {
  const expected = [
    'appInfo', 'checkCompat', 'authStatus', 'signOut', 'signIn',
    'detectInstalls', 'browseForInstall', 'readNights', 'watch', 'unwatch', 'resume',
    'getSettings', 'saveSettings', 'listGuilds', 'upload',
    'pendingLootExports', 'uploadLootSession', 'openInRaidify',
    'updateStatus', 'installUpdate',
    'onNights', 'onEmptyRead', 'onWatchError', 'onUpdateReady',
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

         // A working bridge and a blank window is a real combination: a thrown error in
         // App() leaves an empty root and every check above still passes. Poll rather
         // than sample once — first paint can beat the first render by a frame.
         const deadline = Date.now() + 5000;
         let text = '';
         while (Date.now() < deadline) {
           text = document.body.innerText || '';
           if (text.includes('Raidify Companion')) break;
           await new Promise((r) => setTimeout(r, 100));
         }
         if (!text.includes('Raidify Companion')) {
           return { ok: false, reason: 'the window rendered nothing (body: ' + JSON.stringify(text.slice(0, 120)) + ')' };
         }

         return { ok: true, version: info.version };
       })()`,
    );

    if (!report?.ok) {
      console.error(`SMOKE FAIL: ${report?.reason ?? 'unknown'}`);
      app.exit(1);
      return;
    }

    console.log(`SMOKE OK: bridge exposes ${expected.length} calls, appInfo returned v${report.version}, and the window rendered.`);
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
  // Why not, when not. "No secure credential store" is accurate and unhelpful on a Linux
  // desktop whose only missing piece is a keyring daemon nobody has had to think about.
  signInMemoryBlocker: persistenceBlocker(),
  platform: process.platform,
}));

// ── diagnostics ─────────────────────────────────────────────────────────────────

/**
 * Everything the officer is about to hand over, so they can read it first.
 *
 * The renderer shows this verbatim rather than describing it. A report you are asked to send
 * without being shown is a report a cautious person declines, and the cautious people are
 * disproportionately the ones running an app like this for a guild.
 */
ipcMain.handle('diagnostics:report', () => ({
  report: buildReport(),
  appVersion: CLIENT_VERSION,
  platform: `${process.platform} ${process.arch}`,
  directory: diagnosticsDirectory(),
}));

/** Show them the log in Explorer, for anyone who would rather read the whole thing. */
ipcMain.handle('diagnostics:openFolder', () => {
  const dir = diagnosticsDirectory();
  if (dir) void shell.openPath(dir);
});

/**
 * Send it to Raidify.
 *
 * The summary is derived here rather than in the renderer: the last ERROR line in the log is
 * a better title than anything the UI could guess, and it means the admin list sorts into
 * recognisable groups without anybody writing a subject line.
 */
ipcMain.handle('diagnostics:send', async (_event, note: unknown) => {
  const report = buildReport();
  const settings = loadSettings();

  const summary =
    report
      .split('\n')
      .reverse()
      .find((line) => line.includes(' ERROR '))
      ?.slice(0, 300) ?? 'Companion report (no error recorded)';

  const result = await api.sendErrorReport({
    report,
    summary,
    userNote: typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : undefined,
    appVersion: CLIENT_VERSION,
    platform: `${process.platform} ${process.arch}`,
    guildId: settings.guildId,
  });

  logInfo(`Diagnostic report sent (${result.reportId})`);
  return result;
});

/**
 * Errors the renderer saw, forwarded so they land in the same file as everything else.
 *
 * A React render error or a rejected promise in the UI is invisible to the main process, and
 * it is the half of the app the officer is actually looking at when something goes wrong.
 */
ipcMain.handle('diagnostics:reportRendererError', (_event, payload: unknown) => {
  const { message, stack } = (payload ?? {}) as { message?: string; stack?: string };
  const error = new Error(message ?? 'Unknown renderer error');
  if (stack) error.stack = stack;
  logError('Error in the window', error);
});

/** Whether a downloaded update is sitting there waiting for a restart. */
ipcMain.handle('update:status', () => updateReady);

/**
 * Restart into the update the officer has already downloaded.
 *
 * They pick the moment, which is the whole point — an app that restarts itself at 20:15
 * on a Tuesday is an app that gets closed before raid.
 */
ipcMain.handle('update:install', () => {
  if (!updateReady) return { restarting: false };
  watcher?.stop();
  autoUpdater.quitAndInstall();
  return { restarting: true };
});

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
      buildAuthorizeUrl(WEB_BASE_URL, {
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
ipcMain.handle('wow:browse', async (): Promise<BrowseResult> => {
  if (!window) return { outcome: 'cancelled' };
  const result = await dialog.showOpenDialog(window, {
    title: 'Find your World of Warcraft folder',
    properties: ['openDirectory'],
  });
  const chosen = result.filePaths[0];

  // Cancelling is not a failed search, and a folder with nothing in it is not a broken
  // addon. Each says so on its own terms now.
  if (result.canceled || !chosen) return { outcome: 'cancelled' };

  const candidates = remember(await findSavedVariables(chosen));
  return candidates.length > 0
    ? { outcome: 'found', candidates }
    : { outcome: 'none', searchedPath: chosen };
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

/**
 * The loot file that sits alongside each discovered attendance file.
 *
 * Kept as a lookup rather than a second allowlist because the renderer should never name the
 * loot path at all: it is a property of the install we found, so it is derived from the
 * attendance path the renderer chose. That closes the gap where the "nothing is read that
 * discovery did not produce" rule was enforced for one of the two files this app opens.
 */
const lootPathFor = new Map<string, string | null>();

function remember(candidates: SavedVariablesCandidate[]): SavedVariablesCandidate[] {
  for (const candidate of candidates) {
    discovered.add(candidate.path);
    lootPathFor.set(candidate.path, candidate.lootPath ?? null);
  }
  return candidates;
}

/**
 * Re-earn the stored path, rather than trusting it.
 *
 * The remembered file is only usable once this process has found it again the same way it
 * found it originally — by scanning the install folder it came from. That keeps one rule
 * with no exceptions: nothing is read that discovery did not produce. A settings file
 * carried over from another machine, or edited by hand, gets no privileges from having
 * been written down.
 */
async function restoreDiscovered(): Promise<string | null> {
  const { savedVariablesPath, installPath } = loadSettings();
  if (!savedVariablesPath || !installPath) return null;

  try {
    const candidates = remember(await findSavedVariables(installPath));
    const match = candidates.find((c) => c.path === savedVariablesPath);
    if (!match) return null;

    // Keep the loot path in step with what is actually on disk, rather than only when the
    // officer walks through setup again. This covers two ordinary cases: settings written
    // before the loot file was a thing at all, and a guild that installs the loot addon
    // later. Both would otherwise show no loot section and look broken.
    if (loadSettings().lootSavedVariablesPath !== match.lootPath) {
      saveSettings({ lootSavedVariablesPath: match.lootPath });
    }

    return savedVariablesPath;
  } catch {
    // The drive is gone, or the folder moved. Not an error worth a dialog on launch —
    // the officer will be asked to point at it again.
    return null;
  }
}

/** Whether this exact loot file sits alongside an install discovery has found this session. */
function isDiscoveredLootPath(path: string): boolean {
  for (const known of lootPathFor.values()) {
    if (known === path) return true;
  }
  return false;
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
  await startWatching(path);
  return { watching: true, path };
});

async function startWatching(path: string): Promise<void> {
  watcher?.stop();
  watcher = new SavedVariablesWatcher(
    { path },
    {
      onNights: (nights) => emit('wow:nights', nights),
      onError: (error) => emit('wow:error', { message: error.message }),
      // A clean read that found nothing is news. Without this the UI cannot tell "we read
      // the file and there are no raid sessions in it" from "we have never read it", and
      // the officer stares at the same empty panel in both cases — one of which needs
      // them to do something and one of which does not.
      onEmpty: () => emit('wow:empty', { at: new Date().toISOString() }),
    },
  );
  watcher.start();

  // Read once immediately: the interesting flush may already have happened while the
  // app was closed, and a companion that only notices future raids is half a companion.
  await watcher.readNow();
}

/**
 * Open the page on the website that fixes what a check just complained about.
 *
 * The companion can only ever report a problem — every remedy (linking a character,
 * adding a pug as an external raider, correcting an item) lives on the web. Naming the
 * problem and then leaving the officer to go and find the right page themselves is half
 * an answer, and the half that gets abandoned on a raid night.
 *
 * The renderer picks a TARGET, never a URL. Anything that lets a renderer hand this
 * process a string to open is one renderer flaw away from launching something; a fixed
 * set of destinations cannot be talked into a new one.
 */
ipcMain.handle('app:openInRaidify', (_event, target: unknown): void => {
  const { guildId } = loadSettings();
  if (!guildId) return;

  const paths: Record<string, string> = {
    roster: `/guild/${guildId}/members`,
    'loot-raiders': `/guild/${guildId}/loot?tab=raiders`,
    'loot-record': `/guild/${guildId}/loot?tab=ledger`,
  };

  const path = paths[String(target)];
  if (!path) return;

  // Not routed through `openExternally`, which refuses anything but https so a renderer
  // cannot smuggle a `file:` or a shell handler through it. This URL is built here from a
  // fixed list, so it is not renderer-supplied — and the dev web app is plain http.
  void shell.openExternal(`${WEB_BASE_URL}${path}`);
});

ipcMain.handle('wow:unwatch', () => {
  watcher?.stop();
  watcher = null;
  return { watching: false };
});

// ── settings, the guild, and sending ────────────────────────────────────────────

ipcMain.handle('settings:get', (): Settings => loadSettings());

/**
 * Pick up where the last launch left off.
 *
 * One call rather than three, because the renderer should not be able to get the order
 * wrong: re-discover the remembered file, and start watching it if that is what the
 * officer asked for. A null path means the setup question needs asking again.
 */
ipcMain.handle('wow:resume', async (): Promise<{ path: string | null; watching: boolean }> => {
  const path = await restoreDiscovered();
  if (!path) return { path: null, watching: false };
  if (!loadSettings().autoWatch) return { path, watching: false };

  await startWatching(path);
  return { path, watching: true };
});

/**
 * Save the setup answers.
 *
 * Only the three the UI is allowed to set. The upload history is written by the upload
 * itself — letting the renderer edit it would mean a UI bug could mark an unsent night as
 * sent, which is the one lie this app must never tell.
 */
ipcMain.handle('settings:set', (_event, patch: unknown): Settings => {
  const input = (patch ?? {}) as Partial<Settings>;
  const next: Partial<Settings> = {};

  if (typeof input.guildId === 'string' || input.guildId === null) next.guildId = input.guildId;
  if (typeof input.guildName === 'string' || input.guildName === null) {
    next.guildName = input.guildName;
  }
  if (typeof input.autoWatch === 'boolean') next.autoWatch = input.autoWatch;
  if (input.savedVariablesPath === null) {
    next.savedVariablesPath = null;
    next.installPath = null;
    next.lootSavedVariablesPath = null;
  } else if (input.savedVariablesPath !== undefined) {
    // Same rule as reading: a path we did not discover ourselves is not a path we store
    // and then hand to a file read on the next launch.
    next.savedVariablesPath = requireDiscovered(input.savedVariablesPath);
    next.installPath = typeof input.installPath === 'string' ? input.installPath : null;

    // Derived, not accepted. The renderer sends a lootSavedVariablesPath during setup and
    // this handler used to drop it silently, so a guild running the loot addon saw no Loot
    // section at all until they restarted the app — the only other writer runs on resume,
    // which needs a session that was already signed in at launch. Deriving it from the
    // discovered install fixes that without giving the renderer a second path to name.
    next.lootSavedVariablesPath = lootPathFor.get(next.savedVariablesPath) ?? null;
  }

  return saveSettings(next);
});

ipcMain.handle('guild:list', (): Promise<CompanionGuild[]> => api.guilds());

/**
 * Send one night.
 *
 * `dryRun` runs the identical server path and writes nothing, so the preview the officer
 * approves is the work that then happens — not a second implementation of it that can
 * disagree. A dry run is never recorded as an upload.
 */
ipcMain.handle(
  'attendance:upload',
  async (_event, request: unknown): Promise<AttendanceUploadResult> => {
    const { night, dryRun } = (request ?? {}) as { night?: ParsedNight; dryRun?: boolean };
    if (!night) throw new Error('No night to upload.');

    const { guildId } = loadSettings();
    if (!guildId) throw new Error('Choose which guild this machine reports for first.');

    const result = await api.uploadAttendance(guildId, {
      rows: night.rows,
      // Dates cross IPC as strings; the API wants strings anyway. Normalising here rather
      // than in the renderer keeps the one place that talks to the server the one place
      // that has to know the wire shape.
      startedAt: asIso(night.startedAt),
      endedAt: asIso(night.endedAt),
      raidIdHint: night.raidIdHint,
      nightId: night.nightId,
      clientVersion: CLIENT_VERSION,
      dryRun: dryRun === true,
    });

    if (!dryRun) {
      rememberUpload({
        key: nightKey(night.characterKey, night.startedAt),
        uploadedAt: new Date().toISOString(),
        raidTitle: result.raidTitle ?? night.raidTitle,
        recorded: result.recorded,
        updated: result.updated,
      });
    }

    return result;
  },
);

/**
 * Loot nights this machine has exported and not yet sent.
 *
 * Returns an empty list rather than an error when the loot addon is not installed — most
 * guilds do not run loot council, and that is a fact about the guild, not a fault.
 */
ipcMain.handle('loot:pending', async (): Promise<PendingLootExport[]> => {
  const { lootSavedVariablesPath, uploadedLootNights } = loadSettings();
  if (!lootSavedVariablesPath) return [];

  // Re-earn it, the same rule the attendance file follows. This path came out of settings,
  // and a settings file can be copied from another machine or edited by hand — it should not
  // buy a file read and a Lua evaluation on the strength of having been written down.
  if (!isDiscoveredLootPath(lootSavedVariablesPath)) {
    await restoreDiscovered();
    if (!isDiscoveredLootPath(lootSavedVariablesPath)) return [];
  }

  const contents = await readLootExports(lootSavedVariablesPath);
  if (!contents) return [];

  const alreadySent = new Set(uploadedLootNights);
  // A night with no id cannot be deduplicated, so it is always offered. That is the right
  // way round: showing one twice is a nuisance, silently dropping one loses the record.
  return contents.pending.filter((p) => !p.nightId || !alreadySent.has(p.nightId));
});

/**
 * Send one exported loot session.
 *
 * The payload is forwarded exactly as the addon wrote it. A dry run is never recorded as
 * sent — preview and commit run the same server path, so the preview is the work.
 */
ipcMain.handle(
  'loot:upload',
  async (_event, request: unknown): Promise<LootSessionImportResult> => {
    const { payload, nightId, dryRun } = (request ?? {}) as {
      payload?: string;
      nightId?: string | null;
      dryRun?: boolean;
    };
    if (!payload) throw new Error('No loot session to upload.');

    const { guildId } = loadSettings();
    if (!guildId) throw new Error('Choose which guild this machine reports for first.');

    const result = await api.uploadLootSession(guildId, payload, dryRun === true);

    if (!dryRun && nightId) rememberLootUpload(nightId);

    return result;
  },
);

function asIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

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
    /*
     * Capture mode seeds itself BEFORE the first load.
     *
     * Both of these go through the app's own storage functions rather than being written
     * by the script that spawns us, because only the app knows where its own userData is:
     * run unpackaged, Electron uses %APPDATA%/Electron rather than the product name, so a
     * script writing settings.json "where the app keeps it" wrote it somewhere the app
     * never read and the capture showed an unconfigured app.
     *
     * Doing it after the window is up does not work either — storing the token and
     * reloading raced the capture's own wait.
     */
    if (process.env.RAIDIFY_CAPTURE) {
      if (process.env.RAIDIFY_CAPTURE_FRESH === '1') {
        clearToken();
        saveSettings({
          guildId: null, guildName: null,
          savedVariablesPath: null, lootSavedVariablesPath: null, installPath: null,
        });
      }
      if (process.env.RAIDIFY_CAPTURE_TOKEN) saveToken(process.env.RAIDIFY_CAPTURE_TOKEN);
      if (process.env.RAIDIFY_CAPTURE_SETTINGS) {
        saveSettings(JSON.parse(process.env.RAIDIFY_CAPTURE_SETTINGS) as Partial<Settings>);
      }
    }

    createWindow();
    startUpdateChecks();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    watcher?.stop();
    app.quit();
  });
}
