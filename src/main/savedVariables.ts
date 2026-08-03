import { readFile, stat } from 'node:fs/promises';
import { AttendanceBucket, type AttendanceRow } from '../shared/contract';
import type { ParsedNight } from '../shared/types';
import { LuaParseError, readSavedVariable, toArray } from './lua';

/**
 * Turning `RaidifyDB.lua` into a night we can upload.
 *
 * ⚠️ **This mirrors logic that also lives in Lua.** `Raidify:GetAttendanceData()` in
 * `Attendance.lua` buckets the same way against live game state; this reproduces it from
 * what reached disk. Two implementations of one rule will drift, so the grace period and
 * the status codes below are written to match that function exactly, and any change
 * there has to be made here too.
 *
 * The durable fix is for the addon to persist the *bucketed* result when a session ends,
 * leaving this file to read buckets rather than compute them. Worth doing before the
 * rules get any more interesting than "late" and "left early".
 */

/** Matches `leftEarlyGraceSeconds` in `Attendance.lua`. */
const LEFT_EARLY_GRACE_SECONDS = 300;

/**
 * Matches `lateGraceSeconds` in `Attendance.lua`.
 *
 * `firstSeen` is a real sighting, so everyone at the pull is a few seconds after the
 * session start. Without this window the whole raid reads as late.
 */
const LATE_GRACE_SECONDS = 300;

/** Sign-up status codes as the roster export carries them. */
const STATUS = { APPROVED: 1, WAITLISTED: 3, TENTATIVE: 5 } as const;

interface RosterEntry {
  name?: string;
  realm?: string;
  status?: number;
}

interface Tracker {
  everPresent?: Record<string, boolean>;
  firstSeen?: Record<string, number>;
  lastSeen?: Record<string, number>;
}

interface AttendanceSession {
  startedAt?: number;
  endedAt?: number;
  tracker?: Tracker;
  lastKnownMembers?: Record<string, unknown>;
}

interface ImportedData {
  raidInfo?: { id?: string; title?: string };
  /** Unknown on purpose — wasmoon hands this back as an array or an object depending on
   *  its size, so it must go through {@link toArray} rather than being indexed. */
  currentRoster?: unknown;
}

/**
 * A night the addon finished with before it could be uploaded.
 *
 * Carries its own roster, because the buckets cannot be reconstructed from the roster
 * that happens to be loaded now — archiving exists precisely for the case where a newer
 * import replaced it.
 */
interface ArchivedSession extends AttendanceSession {
  roster?: unknown;
  raidInfo?: { id?: string; title?: string };
}

interface CharScope {
  attendanceSession?: AttendanceSession;
  attendanceHistory?: unknown;
  importedData?: ImportedData;
}

export class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSessionError';
  }
}

/**
 * Lowercase a character name the way the addon does — byte-wise ASCII only.
 *
 * WoW's Lua 5.1 `string.lower` is C `tolower` per byte under the C locale: it maps A–Z
 * and leaves every high byte alone. Names are UTF-8, so the addon writes its tracker keys
 * with the non-ASCII bytes untouched — `Ómen` stays `Ómen`.
 *
 * JavaScript's `toLowerCase()` does full Unicode folding and would produce `ómen`, which
 * matches nothing the addon wrote. Every accented raider — Ómen, Ánduin, Bjørn, Müller,
 * and every raider on a Cyrillic realm — then looked like a no-show, silently, with a
 * perfectly well-formed row and no warning anywhere.
 *
 * So we deliberately reproduce the addon's narrower behaviour rather than the "correct"
 * one. The two must agree; being right on our own is worse than being bug-compatible.
 */
function addonLower(name: string): string {
  let out = '';
  for (const char of name) {
    const code = char.charCodeAt(0);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : char;
  }
  return out;
}

/**
 * Read a key from a table wasmoon built, without inheriting from Object.prototype.
 *
 * wasmoon returns plain `{}` objects, so `everPresent['constructor']` is truthy for a
 * raider legitimately named Constructor — an approved no-show credited as present. And a
 * `["__proto__"]` key in the file replaces the object's prototype outright, which would
 * let a corrupt or crafted file forge presence for arbitrary names.
 */
function ownValue(table: Record<string, unknown> | undefined, key: string): unknown {
  if (!table) return undefined;
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Unix seconds → Date, tolerating the field being absent or nonsense. */
function toDate(seconds: number | undefined): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

/**
 * Bucket one character's night.
 *
 * Mirrors `Attendance.lua:426-500`. Read them side by side when changing either.
 */
export function bucketNight(characterKey: string, scope: CharScope): ParsedNight {
  const session = scope.attendanceSession;
  if (!session) throw new NoSessionError(`No attendance session saved for ${characterKey}.`);

  const roster = toArray<RosterEntry>(scope.importedData?.currentRoster);
  if (roster.length === 0) {
    // Without the roster there is nothing to be absent *from*: the addon would only
    // know who it saw, and reporting that as a complete night would silently erase
    // every no-show. Refuse rather than upload a half-truth.
    throw new NoSessionError(
      `${characterKey} has a session but no imported roster, so absences cannot be established.`,
    );
  }

  const tracker = session.tracker ?? {};
  const everPresent = tracker.everPresent ?? {};
  const firstSeen = tracker.firstSeen ?? {};
  const lastSeen = tracker.lastSeen ?? {};
  const inRaid = session.lastKnownMembers ?? {};

  const startedAt = session.startedAt;
  // The Lua falls back to "now" for left-early detection on a session still running.
  const endedAt = session.endedAt ?? Math.floor(Date.now() / 1000);

  const rows: AttendanceRow[] = [];

  for (const player of roster) {
    const name = player.name;
    if (!name) continue;

    const status = player.status;
    if (status !== STATUS.APPROVED && status !== STATUS.WAITLISTED && status !== STATUS.TENTATIVE) {
      continue;
    }

    // Must match how the addon built its keys, not how JS would prefer to.
    const key = addonLower(name);
    const first = ownValue(firstSeen, key) as number | undefined;
    const last = ownValue(lastSeen, key) as number | undefined;

    const row = (bucket: AttendanceBucket): AttendanceRow => ({
      name,
      bucket,
      realm: player.realm ?? null,
      firstSeen: toDate(first)?.toISOString() ?? null,
      lastSeen: toDate(last)?.toISOString() ?? null,
    });

    if (ownValue(inRaid, key) !== undefined) {
      // Still in the group when the addon last looked.
      rows.push(
        row(
          first && startedAt && first - startedAt >= LATE_GRACE_SECONDS
            ? AttendanceBucket.Late
            : AttendanceBucket.Present,
        ),
      );
      continue;
    }

    if (ownValue(everPresent, key)) {
      // Was here, then wasn't. Only call that leaving early if they went well before
      // the end — otherwise it is just the raid breaking up.
      rows.push(
        last && endedAt - last >= LEFT_EARLY_GRACE_SECONDS
          ? row(AttendanceBucket.LeftEarly)
          : row(AttendanceBucket.Present),
      );
      continue;
    }

    // Never seen. Which of the three that means depends on what they signed up as, and
    // the distinction is the whole point: a raider asked to sit did everything right.
    if (status === STATUS.WAITLISTED) rows.push(row(AttendanceBucket.Benched));
    else if (status === STATUS.TENTATIVE) rows.push(row(AttendanceBucket.Excused));
    else rows.push(row(AttendanceBucket.Absent));
  }

  return {
    characterKey,
    raidIdHint: scope.importedData?.raidInfo?.id ?? null,
    raidTitle: scope.importedData?.raidInfo?.title ?? null,
    startedAt: toDate(startedAt),
    endedAt: toDate(session.endedAt),
    finished: toDate(session.endedAt) !== null,
    rows,
  };
}

/**
 * Read a `RaidifyDB.lua` and return every character's night in it.
 *
 * Falls back to `RaidifyDB.lua.bak` when the main file will not parse. WoW keeps the
 * previous copy, and a crash mid-flush leaves a good `.bak` beside a truncated `.lua` —
 * reading the backup is how the officer keeps the night instead of being told it is gone.
 */
export async function readNights(path: string): Promise<ParsedNight[]> {
  let db: Record<string, unknown> | null;

  // Read and parse are separated deliberately. The `.bak` is by definition the PREVIOUS
  // flush, so falling back to it on an I/O error — EBUSY while WoW swaps the file, EACCES,
  // a momentary ENOENT during the rename — would serve last week's raid as tonight's,
  // with nothing marking it as stale. Only a *parse* failure justifies the backup, because
  // that is the one case where the live file is genuinely damaged.
  const source = await readFile(path, 'utf8');

  try {
    db = await readSavedVariable<Record<string, unknown>>(source, 'RaidifyDB');
  } catch (parseError) {
    if (!(parseError instanceof LuaParseError)) throw parseError;

    const backup = `${path}.bak`;
    try {
      db = await readSavedVariable<Record<string, unknown>>(await readFile(backup, 'utf8'), 'RaidifyDB');
    } catch {
      throw parseError;
    }
  }

  if (!db) return [];

  const chars = (db.char ?? {}) as Record<string, CharScope>;
  const nights: ParsedNight[] = [];

  for (const [characterKey, scope] of Object.entries(chars)) {
    try {
      nights.push(bucketNight(characterKey, scope));
    } catch (error) {
      // One character without a session is the normal case — most alts never raid.
      if (!(error instanceof NoSessionError)) throw error;
    }

    // Nights the addon set aside because a new roster was imported before they were
    // uploaded. Without these, importing Thursday's roster on Thursday afternoon
    // silently destroyed Wednesday — and "upload whenever" is what we tell officers.
    for (const archived of toArray<ArchivedSession>(scope.attendanceHistory)) {
      try {
        nights.push(
          bucketNight(characterKey, {
            attendanceSession: archived,
            importedData: { raidInfo: archived.raidInfo, currentRoster: archived.roster },
          }),
        );
      } catch (error) {
        if (!(error instanceof NoSessionError)) throw error;
      }
    }
  }

  return nights;
}

/**
 * Wait until a file stops changing size.
 *
 * WoW writes SavedVariables by rename and the file is large, so a watch event can arrive
 * with the write still in progress. Reading then yields a truncated file that parses as
 * a shorter night — which is worse than not reading at all, because it looks like data.
 */
export async function waitForStableFile(
  path: string,
  {
    intervalMs = 400,
    requiredStableChecks = 3,
    timeoutMs = 30_000,
    // Injectable so the "never settles" case can be tested by controlling what the
    // probe reports. Racing a real writer against a real poller makes a test that
    // passes on a fast machine and fails on a slow one, which is worse than no test.
    probeSize = async (p: string) => (await stat(p)).size,
  }: {
    intervalMs?: number;
    requiredStableChecks?: number;
    timeoutMs?: number;
    probeSize?: (path: string) => Promise<number>;
  } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    // ENOENT is expected here, not exceptional: WoW writes by rename, so the target is
    // momentarily absent mid-swap. Treating it as a hard failure meant the read threw,
    // nothing retried, and the night was not picked up until the next logout — possibly
    // days later. A missing file is simply "still changing".
    let size: number;
    try {
      size = await probeSize(path);
    } catch {
      lastSize = -1;
      stable = 0;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    stable = size === lastSize ? stable + 1 : 0;
    lastSize = size;
    if (stable >= requiredStableChecks) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`${path} kept changing for ${timeoutMs}ms — giving up for now.`);
}
