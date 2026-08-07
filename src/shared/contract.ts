/**
 * The API contract, mirrored.
 *
 * Hand-written rather than generated, because these three types are the entire surface
 * the companion touches and a generator would drag the whole schema along with them.
 * `npm run schema:pull` refreshes the reference copy of the OpenAPI document so a
 * contract change shows up as a diff to review rather than a runtime surprise on a
 * raid night.
 *
 * Source of truth: `apps/api/src/Raidify.Core/DTOs/CompanionDtos.cs` in the raidify repo.
 */

/** Must match `CompanionOptions.PayloadVersion` on the server. */
export const PAYLOAD_VERSION = 1;

/**
 * The addon's own vocabulary. The server maps these to its domain, deliberately — that
 * mapping can then change without shipping a new build to every officer's machine.
 */
export enum AttendanceBucket {
  Present = 0,
  Late = 1,
  LeftEarly = 2,
  Absent = 3,
  Benched = 4,
  Excused = 5,
  /**
   * Signed up, never seen, and no officer said why.
   *
   * Distinct from Excused on purpose: excused means somebody told us in advance, this
   * means nobody knows. Both are refused by the server, but only one of them is a claim
   * about the raider — and reporting "we don't know" as a claim is how a benched raider
   * ends up looking like a no-show.
   */
  Unresolved = 6,
}

export interface AttendanceRow {
  name: string;
  bucket: AttendanceBucket;
  realm?: string | null;
  firstSeen?: string | null;
  lastSeen?: string | null;

  /**
   * Who marked this, when a human did, and how.
   *
   * A bench is only a bench because an officer decided it. The server refuses one it
   * cannot attribute — otherwise signing up waitlisted and going to bed would earn full
   * attendance credit — so these three fields are what turn a bucket into a decision.
   */
  markedBy?: string | null;
  markedAt?: string | null;
  markRoute?: 'invite' | 'sweep' | null;
}

export interface AttendanceUploadRequest {
  rows: AttendanceRow[];
  startedAt?: string | null;
  endedAt?: string | null;
  /**
   * A hint, never an instruction. The server resolves which raid this night belongs to,
   * because this machine's copy of the schedule can be months stale.
   */
  raidIdHint?: string | null;
  clientVersion?: string | null;
  addonVersion?: string | null;
  dryRun?: boolean;
  /**
   * The addon's identity for this night, shared with the loot session export.
   *
   * Both uploads describe one evening from two files. Without this the server matches
   * them on a minute-precision timestamp built from each payload's own start time, and a
   * standalone night gets every attendee written twice.
   */
  nightId?: string | null;
}

/**
 * What the server made of a loot session upload.
 *
 * Mirrors `LootSessionImportResult` in `Raidify.Core/DTOs/LootSessionImportDtos.cs`.
 */
export interface LootSessionImportResult {
  dryRun: boolean;
  guildSlug: string | null;
  startedAt: string | null;
  endedAt: string | null;
  awardsParsed: number;
  recorded: number;
  alreadyRecorded: number;
  unmatchedRecipients: string[];
  unmatchedItems: string[];
  rows: { itemLabel: string; recipient: string; applied: boolean; skipped: string | null }[];
  warnings: string[];
  attendanceParsed: number;
  attendanceRecorded: number;
  unmatchedAttendees: string[] | null;
}

export enum RaidMatch {
  Hint = 0,
  Schedule = 1,
  Standalone = 2,
  Ambiguous = 3,
}

export interface AttendanceUploadResult {
  dryRun: boolean;
  match: RaidMatch;
  raidId: string | null;
  raidTitle: string | null;
  eventKey: string;
  occurredAt: string;
  rowsReceived: number;
  recorded: number;
  updated: number;
  unchanged: number;
  unmatchedRaiders: string[];
  rows: { name: string; bucket: AttendanceBucket; applied: boolean; skipped: string | null }[];
  warnings: string[];
}

/**
 * A guild this machine may report attendance for.
 *
 * The saved-variables file says which characters raided; it never says under whose
 * banner. So the officer picks once, from the guilds the server says they can already
 * manage raids in.
 */
export interface CompanionGuild {
  id: string;
  name: string;
  slug: string;
  gameVersion: number;
  avatarUrl: string | null;
}

export interface CompatResponse {
  minimumClientVersion: string;
  latestClientVersion: string;
  minimumAddonVersion: string;
  payloadVersion: number;
  uploadEnabled: boolean;
  downloadUrl: string | null;
  notice: string | null;
}

/** What the app does about a compat answer. */
export type CompatVerdict =
  | { kind: 'ok'; updateAvailable: boolean }
  | { kind: 'update-required'; downloadUrl: string | null }
  | { kind: 'uploads-paused'; notice: string | null }
  | { kind: 'payload-mismatch'; expected: number; got: number }
  | { kind: 'unreachable'; error: string };

/** Semver compare, enough for `major.minor.patch`. Negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Decide what to do about a compat response.
 *
 * Ordered by severity on purpose: a client that is too old must be told that first, even
 * if uploads also happen to be paused, because "update" is the action either way.
 */
export function evaluateCompat(compat: CompatResponse, clientVersion: string): CompatVerdict {
  if (compareVersions(clientVersion, compat.minimumClientVersion) < 0) {
    return { kind: 'update-required', downloadUrl: compat.downloadUrl };
  }

  // A payload version the server does not speak means uploads would be rejected or,
  // worse, silently misread. Refuse rather than send.
  if (compat.payloadVersion !== PAYLOAD_VERSION) {
    return { kind: 'payload-mismatch', expected: PAYLOAD_VERSION, got: compat.payloadVersion };
  }

  if (!compat.uploadEnabled) {
    return { kind: 'uploads-paused', notice: compat.notice };
  }

  return {
    kind: 'ok',
    updateAvailable: compareVersions(clientVersion, compat.latestClientVersion) < 0,
  };
}
