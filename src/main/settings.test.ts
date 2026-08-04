import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings live under `app.getPath('userData')`, which only exists inside a running
// Electron process. Pointing it at a temp folder is the whole mock.
const userData = mkdtempSync(join(tmpdir(), 'raidify-settings-'));
vi.mock('electron', () => ({ app: { getPath: () => userData } }));

const { loadSettings, saveSettings, rememberUpload, resetSettingsCache } = await import(
  './settings'
);
const { nightKey } = await import('../shared/nightKey');

const FILE = join(userData, 'settings.json');

beforeEach(() => {
  resetSettingsCache();
  writeFileSync(FILE, '{}', 'utf8');
  resetSettingsCache();
});

describe('the setup answers', () => {
  it('survives a restart', () => {
    saveSettings({ guildId: 'g-1', guildName: 'Nerf Inc', autoWatch: false });

    resetSettingsCache();

    const reloaded = loadSettings();
    expect(reloaded.guildId).toBe('g-1');
    expect(reloaded.guildName).toBe('Nerf Inc');
    expect(reloaded.autoWatch).toBe(false);
  });

  /**
   * A settings file that cannot be parsed must cost the officer a setup screen, not a
   * launch. This app's job is to be running when the raid ends.
   */
  it('falls back to defaults rather than failing to start', () => {
    writeFileSync(FILE, '{ this is not json', 'utf8');
    resetSettingsCache();

    const loaded = loadSettings();
    expect(loaded.guildId).toBeNull();
    expect(loaded.uploaded).toEqual([]);
  });

  /**
   * The type is a claim about what we wrote, not about what is on disk. A hand-edited
   * file with the wrong shape must not reach the code that treats these as a path or an
   * array.
   */
  it('refuses values of the wrong type', () => {
    writeFileSync(
      FILE,
      JSON.stringify({ guildId: 42, savedVariablesPath: { nope: true }, uploaded: 'lots' }),
      'utf8',
    );
    resetSettingsCache();

    const loaded = loadSettings();
    expect(loaded.guildId).toBeNull();
    expect(loaded.savedVariablesPath).toBeNull();
    expect(loaded.uploaded).toEqual([]);
  });

  it('leaves no temporary file behind', () => {
    saveSettings({ guildId: 'g-2' });

    expect(readdirSync(userData).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the record of what has been sent', () => {
  const entry = (key: string) => ({
    key,
    uploadedAt: new Date().toISOString(),
    raidTitle: 'Naxx',
    recorded: 40,
    updated: 0,
  });

  /**
   * Re-sending a night is a correction, not a second night. Two history rows for one
   * session would show the officer a duplicate of something that only happened once.
   */
  it('replaces an earlier send of the same night', () => {
    rememberUpload(entry('Toon - Nightslayer|2026-08-01T19:00:00.000Z'));
    rememberUpload({
      ...entry('Toon - Nightslayer|2026-08-01T19:00:00.000Z'),
      recorded: 0,
      updated: 3,
    });

    const { uploaded } = loadSettings();
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.updated).toBe(3);
  });

  it('keeps a bounded history', () => {
    for (let i = 0; i < 260; i++) rememberUpload(entry(`night-${i}`));

    const { uploaded } = loadSettings();
    expect(uploaded).toHaveLength(200);
    // Oldest dropped, newest kept — a history that trims the wrong end is worse than none.
    expect(uploaded.at(-1)?.key).toBe('night-259');
    expect(uploaded.some((u) => u.key === 'night-0')).toBe(false);
  });
});

/**
 * The main process writes this key from a Date; the renderer computes it again from
 * whatever survived IPC. If those two disagree by so much as a format, every night
 * already sent is offered again forever — which is precisely the nagging the history
 * exists to stop.
 */
describe('the night key', () => {
  it('is the same whether the time arrives as a Date or a string', () => {
    const when = new Date('2026-08-01T19:04:33.000Z');

    expect(nightKey('Toon - Nightslayer', when)).toBe(
      nightKey('Toon - Nightslayer', when.toISOString()),
    );
  });

  it('distinguishes two characters on the same night', () => {
    const when = new Date('2026-08-01T19:04:33.000Z');

    expect(nightKey('Toon - Nightslayer', when)).not.toBe(nightKey('Alt - Nightslayer', when));
  });

  it('does not collapse every unknown time into a match', () => {
    // Two sessions with no start time are still two sessions on different characters.
    expect(nightKey('Toon - Nightslayer', null)).not.toBe(nightKey('Alt - Nightslayer', null));
  });
});
