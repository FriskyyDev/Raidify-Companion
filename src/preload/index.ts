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
};

export type CompanionBridge = typeof bridge;

contextBridge.exposeInMainWorld('companion', bridge);
