import type {
  AttendanceUploadRequest,
  AttendanceUploadResult,
  CompatResponse,
} from '../shared/contract';

/**
 * Everything that leaves this machine goes through here.
 *
 * Deliberately small: two calls, both against the public API as an authenticated user.
 * If this file ever grows a third kind of request, that is worth a second look — the
 * consent screen promises attendance rows, not a general-purpose channel.
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
