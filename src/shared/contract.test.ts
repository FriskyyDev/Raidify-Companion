import { describe, expect, it } from 'vitest';
import { compareVersions, evaluateCompat, PAYLOAD_VERSION, type CompatResponse } from './contract';

const base: CompatResponse = {
  minimumClientVersion: '0.1.0',
  latestClientVersion: '0.1.0',
  minimumAddonVersion: '1.8.9',
  payloadVersion: PAYLOAD_VERSION,
  uploadEnabled: true,
  downloadUrl: null,
  notice: null,
};

describe('compareVersions', () => {
  it('orders by each part, not lexically', () => {
    // The one that bites: '0.10.0' sorts before '0.9.0' as a string.
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });
});

describe('evaluateCompat', () => {
  it('tells an out-of-date client to update before anything else', () => {
    // Uploads are also paused here — but "update" is the action either way, and two
    // problems shown at once is how an officer ends up fixing neither.
    const verdict = evaluateCompat(
      { ...base, minimumClientVersion: '0.2.0', uploadEnabled: false },
      '0.1.0',
    );
    expect(verdict.kind).toBe('update-required');
  });

  it('refuses to upload when the server speaks a different payload version', () => {
    const verdict = evaluateCompat({ ...base, payloadVersion: PAYLOAD_VERSION + 1 }, '0.1.0');
    expect(verdict.kind).toBe('payload-mismatch');
  });

  it('reports a paused upload rather than failing silently', () => {
    const verdict = evaluateCompat({ ...base, uploadEnabled: false }, '0.1.0');
    expect(verdict.kind).toBe('uploads-paused');
  });

  it('nudges but does not block when a newer build exists', () => {
    const verdict = evaluateCompat({ ...base, latestClientVersion: '0.4.0' }, '0.1.0');
    expect(verdict).toEqual({ kind: 'ok', updateAvailable: true });
  });

  it('is happy when the client is current', () => {
    expect(evaluateCompat(base, '0.1.0')).toEqual({ kind: 'ok', updateAvailable: false });
  });
});
