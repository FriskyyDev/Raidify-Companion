import { contextBridge, ipcRenderer } from 'electron';
import type {
  BrowseResult,
  ParsedNight,
  PendingLootExport,
  SavedVariablesCandidate,
  Settings,
} from '../shared/types';
import type {
  AttendanceUploadResult,
  CompanionGuild,
  CompatVerdict,
  LootSessionImportResult,
} from '../shared/contract';

/**
 * The only way the UI can reach anything real.
 *
 * Named calls, not a generic invoke passthrough — if this were `invoke(channel, ...args)`
 * the boundary would be decorative. Anything added here should be readable as a sentence
 * describing something the officer asked for.
 */
const bridge = {
  appInfo: (): Promise<{
    version: string;
    canRememberSignIn: boolean;
    signInMemoryBlocker: string | null;
    platform: string;
  }> =>
    ipcRenderer.invoke('app:info'),

  checkCompat: (): Promise<CompatVerdict> => ipcRenderer.invoke('compat:check'),

  authStatus: (): Promise<{ signedIn: boolean }> => ipcRenderer.invoke('auth:status'),
  signOut: (): Promise<{ signedIn: boolean }> => ipcRenderer.invoke('auth:signOut'),
  signIn: (): Promise<{ signedIn: boolean; label: string }> => ipcRenderer.invoke('auth:signIn'),

  detectInstalls: (): Promise<SavedVariablesCandidate[]> => ipcRenderer.invoke('wow:autoDetect'),
  browseForInstall: (): Promise<BrowseResult> => ipcRenderer.invoke('wow:browse'),
  readNights: (path: string): Promise<ParsedNight[]> => ipcRenderer.invoke('wow:read', path),
  watch: (path: string): Promise<{ watching: boolean; path: string }> =>
    ipcRenderer.invoke('wow:watch', path),
  unwatch: (): Promise<{ watching: boolean }> => ipcRenderer.invoke('wow:unwatch'),
  /** Re-find the remembered file and, if asked for, start watching it. */
  resume: (): Promise<{ path: string | null; watching: boolean }> =>
    ipcRenderer.invoke('wow:resume'),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),

  listGuilds: (): Promise<CompanionGuild[]> => ipcRenderer.invoke('guild:list'),

  /** `dryRun` previews on the real server path and writes nothing. */
  upload: (night: ParsedNight, dryRun: boolean): Promise<AttendanceUploadResult> =>
    ipcRenderer.invoke('attendance:upload', { night, dryRun }),

  /**
   * Open the page on the website that fixes a problem a check reported.
   *
   * A named destination, not a URL — see the handler for why the renderer is not trusted
   * to say where the browser goes.
   */
  openInRaidify: (target: 'roster' | 'loot-raiders' | 'loot-record'): Promise<void> =>
    ipcRenderer.invoke('app:openInRaidify', target),

  /** Exported loot nights not yet sent. Empty when the loot addon is not installed. */
  pendingLootExports: (): Promise<PendingLootExport[]> => ipcRenderer.invoke('loot:pending'),
  uploadLootSession: (
    payload: string,
    nightId: string | null,
    dryRun: boolean,
  ): Promise<LootSessionImportResult> =>
    ipcRenderer.invoke('loot:upload', { payload, nightId, dryRun }),

  /** Fires whenever a flush produced a readable night. Returns an unsubscribe. */
  onNights: (handler: (nights: ParsedNight[]) => void): (() => void) => {
    const listener = (_event: unknown, nights: ParsedNight[]) => handler(nights);
    ipcRenderer.on('wow:nights', listener);
    return () => ipcRenderer.removeListener('wow:nights', listener);
  },

  /** The file read cleanly and held no raid session. Fires instead of `onNights`. */
  onEmptyRead: (handler: (info: { at: string }) => void): (() => void) => {
    const listener = (_event: unknown, info: { at: string }) => handler(info);
    ipcRenderer.on('wow:empty', listener);
    return () => ipcRenderer.removeListener('wow:empty', listener);
  },

  updateStatus: (): Promise<{ version: string } | null> => ipcRenderer.invoke('update:status'),
  installUpdate: (): Promise<{ restarting: boolean }> => ipcRenderer.invoke('update:install'),

  /** An update finished downloading and a restart would land it. */
  onUpdateReady: (handler: (info: { version: string }) => void): (() => void) => {
    const listener = (_event: unknown, info: { version: string }) => handler(info);
    ipcRenderer.on('update:ready', listener);
    return () => ipcRenderer.removeListener('update:ready', listener);
  },

  onWatchError: (handler: (error: { message: string }) => void): (() => void) => {
    const listener = (_event: unknown, error: { message: string }) => handler(error);
    ipcRenderer.on('wow:error', listener);
    return () => ipcRenderer.removeListener('wow:error', listener);
  },

  /** Exactly what a report would contain, so the officer can read it before sending. */
  diagnosticsReport: (): Promise<{
    report: string;
    appVersion: string;
    platform: string;
    directory: string | null;
  }> => ipcRenderer.invoke('diagnostics:report'),

  /** Send it to Raidify. `note` is what the officer typed about what they were doing. */
  sendDiagnostics: (note: string): Promise<{ reportId: string }> =>
    ipcRenderer.invoke('diagnostics:send', note),

  openLogFolder: (): Promise<void> => ipcRenderer.invoke('diagnostics:openFolder'),

  /** Forward a renderer-side error so it lands in the same log as everything else. */
  reportRendererError: (error: { message: string; stack?: string }): Promise<void> =>
    ipcRenderer.invoke('diagnostics:reportRendererError', error),
};

export type CompanionBridge = typeof bridge;

contextBridge.exposeInMainWorld('companion', bridge);

/*
 * Catch what the window itself throws.
 *
 * Installed in the preload rather than in React so it covers errors thrown before the app
 * mounts, which is exactly when a broken build fails. Both handlers are best-effort: a
 * logger that can throw during error handling turns one fault into two.
 */
/*
 * `window` is not in this file's type environment — the preload is typechecked with the node
 * config, because it imports from electron's main-adjacent surface. It genuinely runs in a
 * browser context, so the global is real; only the types are absent.
 */
declare const window: {
  addEventListener(type: string, handler: (event: never) => void): void;
};

const report = (message: string, stack?: string): void => {
  void ipcRenderer.invoke('diagnostics:reportRendererError', { message, stack }).catch(() => {});
};

window.addEventListener('error', (event: never) => {
  const e = event as unknown as { message?: string; error?: unknown };
  report(e.message ?? 'Unknown error', e.error instanceof Error ? e.error.stack : undefined);
});

window.addEventListener('unhandledrejection', (event: never) => {
  const reason = (event as unknown as { reason?: unknown }).reason;
  report(
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined,
  );
});
