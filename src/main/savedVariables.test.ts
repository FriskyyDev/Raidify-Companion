import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttendanceBucket } from '../shared/contract';
import { NoSessionError, bucketNight, readNights, waitForStableFile } from './savedVariables';

const FIXTURE = resolve(
  'fixtures/wow/_classic_era_/WTF/Account/TESTACCOUNT#1/SavedVariables/RaidifyDB.lua',
);

function bucketOf(rows: { name: string; bucket: AttendanceBucket }[], name: string) {
  return rows.find((r) => r.name === name)?.bucket;
}

describe('readNights', () => {
  it('buckets a real saved-variables file the way the addon would', async () => {
    const nights = await readNights(FIXTURE);

    // The alt has no session — most characters never raid, and that is not an error.
    expect(nights).toHaveLength(1);
    const night = nights[0]!;

    expect(night.characterKey).toBe('Fenrik - Nightslayer');
    expect(night.raidIdHint).toBe('3f1c9a5e-7b2d-4c88-9a10-5d6e7f801122');
    expect(night.finished).toBe(true);

    // Still in the group at the end, first seen at the start.
    expect(bucketOf(night.rows, 'Fenrik')).toBe(AttendanceBucket.Present);
    // In the group, but first seen an hour after the session began.
    expect(bucketOf(night.rows, 'Latecomer')).toBe(AttendanceBucket.Late);
    // Seen, then gone, and gone well before the end.
    expect(bucketOf(night.rows, 'Bailed')).toBe(AttendanceBucket.LeftEarly);
    // Approved, never seen.
    expect(bucketOf(night.rows, 'Noshow')).toBe(AttendanceBucket.Absent);
    // Waitlisted and never got in — a bench, emphatically not a no-show.
    expect(bucketOf(night.rows, 'Benchwarmer')).toBe(AttendanceBucket.Benched);
    // Tentative and never showed.
    expect(bucketOf(night.rows, 'Maybeperson')).toBe(AttendanceBucket.Excused);

    // Rejected sign-ups are not part of the night at all.
    expect(bucketOf(night.rows, 'Rejected')).toBeUndefined();
    expect(night.rows).toHaveLength(6);
  });

  it('carries the timestamps a raid night is judged by', async () => {
    const [night] = await readNights(FIXTURE);
    expect(night!.startedAt?.toISOString()).toBe(new Date(1754000000 * 1000).toISOString());
    const late = night!.rows.find((r) => r.name === 'Latecomer')!;
    expect(late.firstSeen).toBe(new Date(1754003600 * 1000).toISOString());
  });

  it('falls back to the .bak when the live file was caught mid-write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rfc-'));
    const path = join(dir, 'RaidifyDB.lua');

    // Truncated exactly the way a crash mid-flush leaves it.
    await writeFile(path, 'RaidifyDB = {\n\t["char"] = {\n\t\t["Fenrik - Night', 'utf8');
    await writeFile(`${path}.bak`, await readFile(FIXTURE, 'utf8'), 'utf8');

    const nights = await readNights(path);
    expect(nights).toHaveLength(1);
    expect(nights[0]!.rows).toHaveLength(6);
  });

  it('gives up honestly when neither the file nor its backup parses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rfc-'));
    const path = join(dir, 'RaidifyDB.lua');
    await writeFile(path, 'RaidifyDB = { ["char"] = {', 'utf8');

    await expect(readNights(path)).rejects.toThrow();
  });
});

describe('bucketNight', () => {
  it('refuses a session with no roster rather than erasing every absence', () => {
    // Without the roster the addon only knows who it saw. Uploading that as a complete
    // night would quietly turn six no-shows into nothing at all.
    expect(() =>
      bucketNight('Solo - Realm', {
        attendanceSession: { startedAt: 1, endedAt: 2, tracker: { everPresent: { solo: true } } },
      }),
    ).toThrow(NoSessionError);
  });

  it('treats a raider who left just before the end as present, not gone', () => {
    // The raid breaking up is not the same as leaving early — the grace period exists
    // so the last pull does not cost everyone their attendance.
    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Straggler', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 5000,
        lastKnownMembers: {},
        tracker: { everPresent: { straggler: true }, lastSeen: { straggler: 4900 } },
      },
    });

    expect(night.rows[0]!.bucket).toBe(AttendanceBucket.Present);
  });

  it('marks a night still in progress as unfinished', () => {
    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Fenrik', status: 1 }] },
      attendanceSession: { startedAt: 1000, lastKnownMembers: { fenrik: true } },
    });

    expect(night.finished).toBe(false);
    expect(night.endedAt).toBeNull();
  });
});

describe('waitForStableFile', () => {
  it('returns once the size stops moving', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rfc-'));
    const path = join(dir, 'RaidifyDB.lua');
    await writeFile(path, 'RaidifyDB = {}', 'utf8');

    await expect(
      waitForStableFile(path, { intervalMs: 10, requiredStableChecks: 2, timeoutMs: 2_000 }),
    ).resolves.toBeUndefined();
  });

  it('gives up on a file that never settles', async () => {
    // The probe is injected rather than racing a real writer against the poller — that
    // version passed locally and failed on a slower CI runner, which is exactly the
    // kind of test that teaches people to re-run the build instead of reading it.
    let size = 0;
    const growing = async () => (size += 100);

    await expect(
      waitForStableFile('irrelevant', {
        intervalMs: 1,
        requiredStableChecks: 3,
        timeoutMs: 50,
        probeSize: growing,
      }),
    ).rejects.toThrow(/kept changing/);
  });
});

describe('name keying', () => {
  it('matches accented names the way the addon wrote them', () => {
    // WoW's Lua string.lower is byte-wise C tolower: "Ómen" stays "Ómen". JS
    // toLowerCase() would fold it to "ómen" and match nothing the addon wrote, so every
    // accented EU raider uploaded as a no-show — silently, with a well-formed row.
    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Ómen', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 5000,
        // Key exactly as Lua would have written it: only A-Z lowered.
        lastKnownMembers: { 'Ómen': true },
        tracker: { everPresent: { 'Ómen': true }, firstSeen: { 'Ómen': 1000 } },
      },
    });

    expect(night.rows[0]!.bucket).toBe(AttendanceBucket.Present);
  });

  it('does not credit a raider named Constructor via the prototype', () => {
    // everPresent['constructor'] is Object.prototype.constructor — truthy — so an
    // approved no-show was bucketed Present, and `endedAt - last` on a function is NaN.
    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Constructor', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 5000,
        lastKnownMembers: {},
        tracker: { everPresent: {}, firstSeen: {}, lastSeen: {} },
      },
    });

    expect(night.rows[0]!.bucket).toBe(AttendanceBucket.Absent);
  });

  it('ignores a __proto__ entry trying to forge presence', () => {
    // wasmoon assigns table[key] = value, so a Lua ["__proto__"] key replaces the
    // object's prototype rather than becoming an own property.
    const everPresent = JSON.parse('{"__proto__": {"ringer": true}}') as Record<string, boolean>;

    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Ringer', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 5000,
        lastKnownMembers: {},
        tracker: { everPresent, firstSeen: {}, lastSeen: {} },
      },
    });

    expect(night.rows[0]!.bucket).toBe(AttendanceBucket.Absent);
  });

  it('still calls someone late only well after the pull', () => {
    // firstSeen is now a real sighting, so everyone at the pull is a few seconds after
    // the start. Without the grace window the whole raid would read as late.
    const atThePull = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Ontime', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 9000,
        lastKnownMembers: { ontime: true },
        tracker: { everPresent: { ontime: true }, firstSeen: { ontime: 1030 } },
      },
    });
    expect(atThePull.rows[0]!.bucket).toBe(AttendanceBucket.Present);

    const anHourLate = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Tardy', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 9000,
        lastKnownMembers: { tardy: true },
        tracker: { everPresent: { tardy: true }, firstSeen: { tardy: 4600 } },
      },
    });
    expect(anHourLate.rows[0]!.bucket).toBe(AttendanceBucket.Late);
  });
});
