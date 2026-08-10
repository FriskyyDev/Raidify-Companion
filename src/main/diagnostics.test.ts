import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { redact } from './diagnostics';

/**
 * Redaction is the whole reason this file can be offered to somebody.
 *
 * The report is written to be shared: copied into a Discord channel, or uploaded to Raidify
 * where an admin reads it. Anything that survives redaction has been published, so these are
 * the tests that matter more than the formatting ones.
 */
describe('redact', () => {
  it('removes a bearer token', () => {
    const line = 'GET /api/v1/guilds failed, Authorization: Bearer abc.def.ghi';
    const out = redact(line);

    expect(out).not.toContain('abc.def.ghi');
    expect(out).toContain('[redacted]');
  });

  it('removes a token however it was labelled', () => {
    for (const line of [
      'token=sk-live-1234567890',
      'token: sk-live-1234567890',
      'Bearer sk-live-1234567890',
    ]) {
      expect(redact(line)).not.toContain('sk-live-1234567890');
    }
  });

  it('replaces the home directory, so no report carries a Windows account name', () => {
    const home = homedir();
    const line = `Watching ${home}\\Games\\WoW\\_classic_\\WTF\\Account\\X\\SavedVariables\\Raidify.lua`;
    const out = redact(line);

    expect(out).not.toContain(home);
    expect(out).toContain('~');
    // The part that identifies which install is still there, because that is the half we
    // need to read a bug report at all.
    expect(out).toContain('SavedVariables');
  });

  it('handles a home directory written with forward slashes', () => {
    const home = homedir().replace(/\\/g, '/');
    expect(redact(`opened ${home}/AppData/Roaming`)).not.toContain(home);
  });

  it('leaves an ordinary line alone', () => {
    const line = 'Read 3 nights from the saved-variables file';
    expect(redact(line)).toBe(line);
  });
});
