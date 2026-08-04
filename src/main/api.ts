import type {
  AttendanceUploadRequest,
  AttendanceUploadResult,
  CompanionGuild,
  CompatResponse,
} from '../shared/contract';

/**
 * Everything that leaves this machine goes through here.
 *
 * Deliberately small, and each call earns its place: find out if this build is still
 * supported, trade a code for a token, hand the token back, ask which guilds this
 * sign-in may write to, and upload one night. Nothing here reads a guild's data.
 *
 * Anything added is worth a second look — the consent screen promises attendance rows,
 * not a general-purpose channel into the officer's account.
 */

const DEFAULT_BASE_URL = 'https://www.raidify.app';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  /** Called for every request; returns null when nobody is signed in yet. */
  getToken: () => Promise<string | null>;
  clientVersion: string;
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * Anonymous on purpose. A client too old to authenticate correctly still has to be
   * able to find out that it is too old.
   */
  async compat(signal?: AbortSignal): Promise<CompatResponse> {
    return this.request<CompatResponse>('GET', '/api/v1/companion/compat', {
      authenticated: false,
      signal,
    });
  }

  /**
   * Trade the one-time code plus the verifier we have been holding for a token.
   *
   * Unauthenticated by necessity — the app has no credential yet; acquiring one is the
   * point. What authorises it is the pair: a code that came back through the browser and
   * a verifier that never left this machine.
   */
  async exchangeCode(
    code: string,
    codeVerifier: string,
    signal?: AbortSignal,
  ): Promise<{ token: string; tokenId: string; label: string }> {
    return this.request('POST', '/api/v1/auth/companion/token', {
      authenticated: false,
      body: { code, codeVerifier },
      signal,
    });
  }

  /**
   * Tell the server this installation is done with its credential.
   *
   * Deleting the local copy is not disconnecting: without this the token stayed valid
   * server-side forever, so signing out before selling a laptop left it working.
   */
  async signOut(signal?: AbortSignal): Promise<void> {
    await this.request<void>('POST', '/api/v1/companion/sign-out', { signal });
  }

  /**
   * Which guilds this sign-in may upload for.
   *
   * Filtered server-side by the same permission the upload checks, so anything this
   * returns is safe to offer — the app never has to reason about permissions itself, and
   * cannot get that reasoning subtly wrong on a raid night.
   */
  async guilds(signal?: AbortSignal): Promise<CompanionGuild[]> {
    return this.request<CompanionGuild[]>('GET', '/api/v1/companion/guilds', { signal });
  }

  async uploadAttendance(
    guildId: string,
    body: AttendanceUploadRequest,
    signal?: AbortSignal,
  ): Promise<AttendanceUploadResult> {
    return this.request<AttendanceUploadResult>(
      'POST',
      `/api/v1/guilds/${guildId}/companion/attendance`,
      { body, signal },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; authenticated?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `RaidifyCompanion/${this.options.clientVersion}`,
    };

    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    if (opts.authenticated !== false) {
      const token = await this.options.getToken();
      if (!token) throw new ApiError('Not signed in.', 401);
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });

    if (!response.ok) {
      // The API answers errors as `{ message }`; anything else is an outage or a proxy,
      // and the status alone is more honest than a parse of someone's HTML error page.
      let message = `Request failed (${response.status}).`;
      try {
        const parsed = (await response.json()) as { message?: string };
        if (parsed?.message) message = parsed.message;
      } catch {
        /* keep the status-based message */
      }
      throw new ApiError(message, response.status);
    }

    return (await response.json()) as T;
  }
}
