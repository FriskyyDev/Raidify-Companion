import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

/**
 * Where the API token lives.
 *
 * `safeStorage` is one API over DPAPI, Keychain and libsecret, which is the single
 * biggest reason this app is Electron rather than .NET — the alternative was three
 * per-platform implementations behind a hand-written interface.
 *
 * When the OS declines to provide encryption we refuse to store the token rather than
 * writing it in the clear. A companion that silently downgrades to a plaintext
 * credential on disk is worse than one that asks the officer to sign in again.
 */

const FILE = () => join(app.getPath('userData'), 'credentials.bin');

export function canPersist(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function saveToken(token: string): void {
  if (!canPersist()) {
    throw new Error(
      'This system has no secure credential store available, so the sign-in cannot be remembered.',
    );
  }

  const path = FILE();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 });
}

export function loadToken(): string | null {
  const path = FILE();
  if (!existsSync(path) || !canPersist()) return null;

  try {
    return safeStorage.decryptString(readFileSync(path));
  } catch {
    // Written by a different OS user, or after a credential-store reset. Not an error
    // worth surfacing — it just means signing in again.
    return null;
  }
}

export function clearToken(): void {
  const path = FILE();
  if (existsSync(path)) unlinkSync(path);
}
