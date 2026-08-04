import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from './api';
import { createPkcePair } from './auth';
import { AttendanceBucket, evaluateCompat, PAYLOAD_VERSION } from '../shared/contract';

/**
 * The whole chain, against a real API.
 *
 * Everything else in this suite tests a piece in isolation: the parser against fixtures,
 * the watcher against a temp file, the compat rules against invented responses. All of it
 * can pass while the app cannot sign in, because nothing here had ever spoken to a server.
 * That is the same gap that once shipped an app whose preload never loaded — every check
 * green, the thing itself dead.
 *
 * So this signs in for real, exchanges a real code for a real token, asks which guilds it
 * may write to, and uploads a night. It is skipped unless pointed at an API, because a
 * test suite that needs a database running to pass is a test suite people stop running.
 *
 *   docker compose up -d                                        # in the raidify repo
 *   dotnet run --project apps/api/src/Raidify.Api --urls http://localhost:5001
 *   RAIDIFY_E2E_API_URL=http://localhost:5001 npm test
 *
 * Needs `AllowTestLogin: true`, which appsettings.Development.json already sets. It will
 * not run against production: test-login 404s there, and the first step would fail loudly
 * rather than quietly doing something to real data.
 */

const BASE_URL = process.env.RAIDIFY_E2E_API_URL;
const describeLive = BASE_URL ? describe : describe.skip;

describeLive('the companion against a real API', () => {
  let webJwt: string;
  let guildId: string;
  let companionToken: string | null = null;

  const api = new ApiClient({
    baseUrl: BASE_URL,
    clientVersion: '0.1.0',
    getToken: async () => companionToken,
  });

  /** The web app's half: an ordinary signed-in session, and a guild it can manage. */
  async function asWebUser<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${webJwt}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  beforeAll(async () => {
    const login = await fetch(`${BASE_URL}/api/v1/auth/test-login`, { method: 'POST' });
    if (!login.ok) {
      throw new Error(
        `test-login → ${login.status}. Set AllowTestLogin, and do not point this at production.`,
      );
    }
    webJwt = ((await login.json()) as { accessToken: string }).accessToken;

    // A fresh guild per run. Reusing one would make the upload assertions depend on
    // whatever the previous run left behind.
    const suffix = Date.now().toString(36);
    const guild = await asWebUser<{ id: string }>('POST', '/api/v1/guilds', {
      name: `Companion E2E ${suffix}`,
      description: 'Created by the companion live test.',
      gameVersion: 1,
    });
    guildId = guild.id;
  }, 60_000);

  it('is a version this server still accepts', async () => {
    const compat = await api.compat();

    expect(compat.payloadVersion).toBe(PAYLOAD_VERSION);
    expect(evaluateCompat(compat, '0.1.0').kind).toBe('ok');
  });

  /**
   * The half of sign-in that has no browser in it.
   *
   * The consent page is what turns a session into an approval; here the test plays that
   * page. What is being checked is the pair — a code that came back through the browser
   * and a verifier that never left this machine — actually buying a token from the real
   * endpoint, with the real PKCE implementation on both sides.
   */
  it('trades an approved code for a token', async () => {
    const { verifier, challenge } = createPkcePair();

    const approved = await asWebUser<{ code: string }>('POST', '/api/v1/auth/companion/approve', {
      codeChallenge: challenge,
      redirectPort: 51789,
      label: 'live test',
    });

    const exchanged = await api.exchangeCode(approved.code, verifier);

    expect(exchanged.token).toBeTruthy();
    companionToken = exchanged.token;
  });

  it('refuses a code presented with the wrong verifier', async () => {
    const { challenge } = createPkcePair();
    const approved = await asWebUser<{ code: string }>('POST', '/api/v1/auth/companion/approve', {
      codeChallenge: challenge,
      redirectPort: 51790,
    });

    await expect(api.exchangeCode(approved.code, createPkcePair().verifier)).rejects.toThrow();
  });

  it('lists the guild it may report for', async () => {
    const guilds = await api.guilds();

    expect(guilds.map((g) => g.id)).toContain(guildId);
  });

  /**
   * The point of the whole app.
   *
   * Dry run, so this leaves nothing behind — and because preview and commit run the same
   * server path, exercising the preview exercises the write.
   */
  it('uploads a night', async () => {
    const startedAt = new Date();
    startedAt.setHours(startedAt.getHours() - 3);

    const result = await api.uploadAttendance(guildId, {
      rows: [
        { name: 'Torvald', bucket: AttendanceBucket.Present },
        { name: 'Kaya', bucket: AttendanceBucket.Late },
        {
          name: 'Bren',
          bucket: AttendanceBucket.Benched,
          markedBy: 'Torvald',
          markedAt: new Date().toISOString(),
          markRoute: 'sweep',
        },
      ],
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      clientVersion: '0.1.0',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.rowsReceived).toBe(3);
    // Nobody in a brand-new guild has a linked character, so every name is unmatched.
    // That is the correct answer, and it is also the shape the UI renders — a result the
    // client cannot read is as bad as no result.
    expect(result.unmatchedRaiders).toHaveLength(3);
    expect(result.eventKey).toBeTruthy();
  });

  /**
   * Signing out has to reach the server. Deleting the local copy of a token is not
   * disconnecting — that left the credential valid forever, so selling the laptop handed
   * it on.
   */
  it('revokes the token when it signs out', async () => {
    await api.signOut();

    await expect(api.guilds()).rejects.toThrow();
  });
});
