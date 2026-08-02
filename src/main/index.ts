import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { ApiClient } from './api';
import { canPersist, clearToken, loadToken, saveToken } from './secrets';
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

// TODO(step 3): the sign-in flow proper — device-code pairing against the web app, then
// `saveToken`. Wired here so the shape is visible; the browser handoff is the next PR.
ipcMain.handle('auth:setToken', (_event, token: unknown) => {
  if (typeof token !== 'string' || token.length === 0) throw new Error('No token supplied.');
  saveToken(token);
  return { signedIn: true };
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
    app.quit();
  });
}
