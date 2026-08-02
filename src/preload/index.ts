import { contextBridge, ipcRenderer } from 'electron';
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
};

export type CompanionBridge = typeof bridge;

contextBridge.exposeInMainWorld('companion', bridge);
