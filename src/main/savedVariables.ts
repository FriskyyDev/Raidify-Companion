import { readFile, stat } from 'node:fs/promises';
import { AttendanceBucket, type AttendanceRow } from '../shared/contract';
import type { ParsedNight } from '../shared/types';
import { readSavedVariable, toArray } from './lua';

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

interface CharScope {
  attendanceSession?: AttendanceSession;
  importedData?: ImportedData;
}

export class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSessionError';
  }
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

    const key = name.toLowerCase();
    const first = firstSeen[key];
    const last = lastSeen[key];

    const row = (bucket: AttendanceBucket): AttendanceRow => ({
      name,
      bucket,
      realm: player.realm ?? null,
      firstSeen: toDate(first)?.toISOString() ?? null,
      lastSeen: toDate(last)?.toISOString() ?? null,
    });

    if (Object.prototype.hasOwnProperty.call(inRaid, key)) {
      // Still in the group when the addon last looked.
      rows.push(row(first && startedAt && first > startedAt ? AttendanceBucket.Late : AttendanceBucket.Present));
      continue;
    }

    if (everPresent[key]) {
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
  let source: string;
  let db: Record<string, unknown> | null;

  try {
    source = await readFile(path, 'utf8');
    db = await readSavedVariable<Record<string, unknown>>(source, 'RaidifyDB');
  } catch (primaryError) {
    const backup = `${path}.bak`;
    try {
      source = await readFile(backup, 'utf8');
      db = await readSavedVariable<Record<string, unknown>>(source, 'RaidifyDB');
    } catch {
      throw primaryError;
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
      if (error instanceof NoSessionError) continue;
      throw error;
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
  { intervalMs = 400, requiredStableChecks = 3, timeoutMs = 30_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    const { size } = await stat(path);
    stable = size === lastSize ? stable + 1 : 0;
    lastSize = size;
    if (stable >= requiredStableChecks) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`${path} kept changing for ${timeoutMs}ms — giving up for now.`);
}
