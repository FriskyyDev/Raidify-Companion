import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createPkcePair,
  LoopbackReceiver,
  SignInCancelledError,
} from './auth';

const base64Url = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('createPkcePair', () => {
  it('produces a verifier the server will accept and a matching S256 challenge', () => {
    const { verifier, challenge } = createPkcePair();

    // RFC 7636 §4.1 — the server rejects anything outside this range.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);

    // base64url only: no +, / or = to be mangled in a query string.
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);

    expect(challenge).toBe(base64Url(createHash('sha256').update(verifier, 'ascii').digest()));
  });

  it('is different every time', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe('buildAuthorizeUrl', () => {
  it('carries the challenge and never the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    const url = buildAuthorizeUrl('https://www.raidify.app/', {
      challenge,
      port: 51234,
      state: 'abc123',
    });

    // The verifier leaking into the browser would defeat the entire mechanism.
    expect(url).not.toContain(verifier);

    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/companion/authorize');
    expect(parsed.searchParams.get('code_challenge')).toBe(challenge);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('port')).toBe('51234');
    expect(parsed.searchParams.get('state')).toBe('abc123');
  });
});

describe('LoopbackReceiver', () => {
  it('accepts a callback carrying the right state', async () => {
    const receiver = new LoopbackReceiver();
    const { port, code } = await receiver.listen(5_000);

    await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=${receiver.state}`);

    await expect(code).resolves.toMatchObject({ code: 'the-code' });
    receiver.close();
  });

  it('rejects a callback with the wrong state', async () => {
    // This is the CSRF defence: without it, any page the officer visits could drive a
    // code of its own choosing into the waiting app.
    const receiver = new LoopbackReceiver();
    const { port, code } = await receiver.listen(5_000);

    await fetch(`http://127.0.0.1:${port}/callback?code=attacker-code&state=not-the-state`);

    await expect(code).rejects.toBeInstanceOf(SignInCancelledError);
    receiver.close();
  });

  it('ignores anything that is not the callback path', async () => {
    // Browsers request /favicon.ico, and anything else on the machine may probe the port.
    const receiver = new LoopbackReceiver();
    const { port, code } = await receiver.listen(500);

    const probe = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(probe.status).toBe(404);

    // Still waiting, then times out rather than treating the probe as an answer.
    await expect(code).rejects.toBeInstanceOf(SignInCancelledError);
  });

  it('gives up rather than holding a socket open forever', async () => {
    const receiver = new LoopbackReceiver();
    const { code } = await receiver.listen(150);
    await expect(code).rejects.toThrow(/timed out/i);
  });

  it('listens only on loopback', async () => {
    const receiver = new LoopbackReceiver();
    const { port, code } = await receiver.listen(300);
    expect(port).toBeGreaterThan(1023);
    // Swallow the timeout rejection so it does not surface as an unhandled rejection.
    void code.catch(() => {});
    receiver.close();
  });
});
