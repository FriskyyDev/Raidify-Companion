import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Token storage, and specifically the Linux case that cannot be checked by hand from a
 * Windows or macOS machine.
 *
 * `safeStorage.isEncryptionAvailable()` answers **true** on a Linux desktop with no
 * keyring, where Electron falls back to a backend called `basic_text` that scrambles with
 * a key hardcoded in Chromium. Trusting that answer alone meant writing a working API
 * token to disk in effectively plain text while telling the officer it was stored
 * securely — the exact downgrade the module's own comment says it refuses to perform.
 *
 * Nothing here talks to a real credential store; the point is the decision made from what
 * one reports.
 */

const userData = mkdtempSync(join(tmpdir(), 'raidify-secrets-'));
const FILE = join(userData, 'credentials.bin');

const state = {
  available: true,
  backend: 'gnome_libsecret' as string | undefined,
  platform: 'linux' as string,
};

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => {
      if (state.backend === undefined) throw new Error('not supported on this platform');
      return state.backend;
    },
    // Stand-ins. Reversing the string is enough to prove which bytes were written and
    // that a round trip happened; the real implementation is the OS's problem.
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

const { canPersist, persistenceBlocker, saveToken, loadToken, clearToken } = await import(
  './secrets'
);

const realPlatform = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  state.available = true;
  state.backend = 'gnome_libsecret';
  setPlatform('linux');
  clearToken();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('a machine with a real credential store', () => {
  it('keeps the sign-in and gives it back', () => {
    saveToken('tok-abc');

    expect(loadToken()).toBe('tok-abc');
    expect(canPersist()).toBe(true);
    expect(persistenceBlocker()).toBeNull();
  });

  it('writes something other than the bare token', () => {
    saveToken('tok-abc');

    expect(readFileSync(FILE).toString()).not.toBe('tok-abc');
  });
});

describe('a Linux desktop with no keyring running', () => {
  beforeEach(() => {
    // What Electron actually reports there: encryption "available", backend that isn't.
    state.available = true;
    state.backend = 'basic_text';
  });

  it('refuses to keep the sign-in', () => {
    expect(canPersist()).toBe(false);
  });

  /**
   * The refusal has to be the write refusing, not just the flag reading false. A caller
   * that skipped the flag would otherwise put the token on disk anyway.
   */
  it('refuses to write the token at all', () => {
    expect(() => saveToken('tok-abc')).toThrow();
    expect(existsSync(FILE)).toBe(false);
  });

  /**
   * A file left by a build that trusted isEncryptionAvailable() alone. Declining to read
   * it while leaving it there is the worst outcome: the officer signs in again and the
   * recoverable copy stays on disk indefinitely.
   */
  it('deletes a token an earlier build stored unprotected', () => {
    writeFileSync(FILE, 'enc:tok-from-old-build');

    expect(loadToken()).toBeNull();
    expect(existsSync(FILE)).toBe(false);
  });

  /**
   * "No secure credential store" is true and useless here — the desktop looks perfectly
   * normal and the missing piece is a daemon. The message has to name it.
   */
  it('says what to start', () => {
    const blocker = persistenceBlocker();

    expect(blocker).toBeTruthy();
    expect(blocker).toMatch(/keyring|KWallet/i);
  });
});

describe('a machine with no encryption at all', () => {
  beforeEach(() => {
    state.available = false;
    state.backend = 'basic_text';
  });

  it('refuses, and says so without inventing a Linux fix', () => {
    expect(canPersist()).toBe(false);
    expect(persistenceBlocker()).toMatch(/no secure credential store/i);
  });
});

describe('Windows and macOS', () => {
  /**
   * Neither has a backend to choose, and `getSelectedStorageBackend` is Linux-only —
   * older Electron does not define it at all. Calling it anywhere else must not be able
   * to break sign-in.
   */
  it('never consults the Linux backend, even when asking would throw', () => {
    setPlatform('win32');
    state.backend = undefined;

    expect(canPersist()).toBe(true);
    expect(persistenceBlocker()).toBeNull();

    saveToken('tok-win');
    expect(loadToken()).toBe('tok-win');
  });

  /**
   * `basic_text` is a Linux backend name. If the platform check were dropped, a stray
   * answer on Windows would start refusing DPAPI — which works fine.
   */
  it('is not refused by a Linux backend name', () => {
    setPlatform('darwin');
    state.backend = 'basic_text';

    expect(canPersist()).toBe(true);
  });
});
