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

/**
 * Linux desktops without a running keyring.
 *
 * Electron falls back to a backend it calls `basic_text`, which is not encryption: it
 * scrambles with a key hardcoded in Chromium's source, so anything written with it is
 * recoverable by anyone who can read the file. `isEncryptionAvailable()` still answers
 * **true** for it.
 *
 * That answer was the whole check, so on a machine with no gnome-keyring or KWallet this
 * module did exactly what the comment above says it refuses to do — write a working API
 * token to disk in effectively plain text, while telling the officer their sign-in was
 * stored securely. The token uploads attendance for their guild.
 */
const INSECURE_BACKEND = 'basic_text';

/**
 * Which OS credential store is actually behind `safeStorage`, on the one platform where
 * the answer varies. Windows (DPAPI) and macOS (Keychain) have nothing to choose.
 */
function selectedBackend(): string | null {
  if (process.platform !== 'linux') return null;
  // Guarded: the method is Linux-only and absent on older Electron, and a crash here
  // would take out sign-in entirely.
  if (typeof safeStorage.getSelectedStorageBackend !== 'function') return null;

  try {
    return safeStorage.getSelectedStorageBackend();
  } catch {
    return null;
  }
}

export function canPersist(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return selectedBackend() !== INSECURE_BACKEND;
}

/**
 * Why the sign-in cannot be kept, in words that name the fix.
 *
 * "No secure credential store" is true and useless on Linux: the officer has a desktop
 * that looks perfectly normal, and the missing piece is a keyring daemon they have never
 * had to think about. Null when persistence works.
 */
export function persistenceBlocker(): string | null {
  if (canPersist()) return null;

  // Availability first. When there is no encryption at all, the backend can still report
  // `basic_text` — and telling someone to start a keyring daemon when the real problem is
  // that nothing is available sends them off fixing the wrong thing.
  if (safeStorage.isEncryptionAvailable() && selectedBackend() === INSECURE_BACKEND) {
    return 'No keyring is running, so the only store available would keep your sign-in in plain text. Start gnome-keyring or KWallet and sign in again to stay signed in.';
  }

  return 'This system has no secure credential store, so the sign-in cannot be remembered between launches.';
}

export function saveToken(token: string): void {
  const blocker = persistenceBlocker();
  if (blocker) throw new Error(blocker);

  const path = FILE();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, safeStorage.encryptString(token), { mode: 0o600 });
}

export function loadToken(): string | null {
  const path = FILE();
  if (!existsSync(path)) return null;

  if (!canPersist()) {
    // A file written by a build that trusted `isEncryptionAvailable()` alone, on a machine
    // where that answer was wrong. Refusing to read it while leaving it on disk would be
    // the worst of both: the officer signs in again, and the recoverable copy stays there
    // forever. Delete it and make them sign in.
    clearToken();
    return null;
  }

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
