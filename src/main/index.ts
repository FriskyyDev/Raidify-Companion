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

const CLIENT_VERSION = app.getVersion();
const API_BASE_URL = process.env.RAIDIFY_API_URL ?? undefined;

let window: BrowserWindow | null = null;
let watcher: SavedVariablesWatcher | null = null;

/** Tell the UI something happened, if it is there to hear it. */
function emit(channel: string, payload: unknown): void {
  window?.webContents.send(channel, payload);
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
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.on('ready-to-show', () => window?.show());

  // Nothing in this app should ever open a second window, and a link that tries is
  // either a mistake or something worse. Send them to the real browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
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
ipcMain.handle('auth:signOut', () => {
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

ipcMain.handle('wow:autoDetect', (): Promise<SavedVariablesCandidate[]> => autoDetect());

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
  return result.canceled || !chosen ? [] : findSavedVariables(chosen);
});

/** Read whatever is on disk right now, without waiting for the game to flush. */
ipcMain.handle('wow:read', (_event, path: unknown): Promise<ParsedNight[]> => {
  if (typeof path !== 'string' || !path) throw new Error('No saved-variables path supplied.');
  return readNights(path);
});

/**
 * Start watching. One watcher at a time — a second one would double every upload, and
 * two watchers racing on the same file is the kind of bug that only shows up on a night
 * that matters.
 */
ipcMain.handle('wow:watch', async (_event, path: unknown) => {
  if (typeof path !== 'string' || !path) throw new Error('No saved-variables path supplied.');

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
