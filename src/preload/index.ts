import { contextBridge, ipcRenderer } from 'electron';
import type { ParsedNight, SavedVariablesCandidate } from '../shared/types';
import type { CompatVerdict } from '../shared/contract';

/**
 * The only way the UI can reach anything real.
 *
 * Named calls, not a generic invoke passthrough — if this were `invoke(channel, ...args)`
 * the boundary would be decorative. Anything added here should be readable as a sentence
 * describing something the officer asked for.
 */
const bridge = {
  appInfo: (): Promise<{ version: string; canRememberSignIn: boolean; platform: string }> =>
    ipcRenderer.invoke('app:info'),

  checkCompat: (): Promise<CompatVerdict> => ipcRenderer.invoke('compat:check'),

  authStatus: (): Promise<{ signedIn: boolean }> => ipcRenderer.invoke('auth:status'),
  signOut: (): Promise<{ signedIn: boolean }> => ipcRenderer.invoke('auth:signOut'),
  setToken: (token: string): Promise<{ signedIn: boolean }> =>
    ipcRenderer.invoke('auth:setToken', token),

  detectInstalls: (): Promise<SavedVariablesCandidate[]> => ipcRenderer.invoke('wow:autoDetect'),
  browseForInstall: (): Promise<SavedVariablesCandidate[]> => ipcRenderer.invoke('wow:browse'),
  readNights: (path: string): Promise<ParsedNight[]> => ipcRenderer.invoke('wow:read', path),
  watch: (path: string): Promise<{ watching: boolean; path: string }> =>
    ipcRenderer.invoke('wow:watch', path),
  unwatch: (): Promise<{ watching: boolean }> => ipcRenderer.invoke('wow:unwatch'),

  /** Fires whenever a flush produced a readable night. Returns an unsubscribe. */
  onNights: (handler: (nights: ParsedNight[]) => void): (() => void) => {
    const listener = (_event: unknown, nights: ParsedNight[]) => handler(nights);
    ipcRenderer.on('wow:nights', listener);
    return () => ipcRenderer.removeListener('wow:nights', listener);
  },

  onWatchError: (handler: (error: { message: string }) => void): (() => void) => {
    const listener = (_event: unknown, error: { message: string }) => handler(error);
    ipcRenderer.on('wow:error', listener);
    return () => ipcRenderer.removeListener('wow:error', listener);
  },
};

export type CompanionBridge = typeof bridge;

contextBridge.exposeInMainWorld('companion', bridge);
