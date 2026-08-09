import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttendanceBucket } from '../shared/contract';
import { NoSessionError, bucketNight, readNights, waitForStableFile } from './savedVariables';

const FIXTURE = resolve(
  'fixtures/wow/_classic_era_/WTF/Account/TESTACCOUNT#1/SavedVariables/Raidify.lua',
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
    // Waitlisted and never seen, with no officer mark. NOT a bench: inferring one from
    // a sign-up is what made "sign up waitlisted, go to bed" a full-credit night.
    expect(bucketOf(night.rows, 'Benchwarmer')).toBe(AttendanceBucket.Unresolved);
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
    const path = join(dir, 'Raidify.lua');

    // Truncated exactly the way a crash mid-flush leaves it.
    await writeFile(path, 'RaidifyDB = {\n\t["char"] = {\n\t\t["Fenrik - Night', 'utf8');
    await writeFile(`${path}.bak`, await readFile(FIXTURE, 'utf8'), 'utf8');

    const nights = await readNights(path);
    expect(nights).toHaveLength(1);
    expect(nights[0]!.rows).toHaveLength(6);
  });

  it('gives up honestly when neither the file nor its backup parses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rfc-'));
    const path = join(dir, 'Raidify.lua');
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

  it('does not call the whole raid "left early" when nobody typed /rf end', () => {
    // The common shape of a first night: a wipe or a partial clear, so the automatic end
    // never fires and nobody runs the command. The officer opens the app the next morning.
    //
    // Substituting "now" for the missing end made everyone who dropped group as the raid
    // broke up hours short of it, and they uploaded as LeftEarly — a false statement about
    // named people that no screen in the app would have shown the officer. The last moment
    // the addon saw anybody is the honest guess, and it does not drift overnight.
    const night = bucketNight('X - Y', {
      importedData: {
        currentRoster: [
          { name: 'Alpha', status: 1 },
          { name: 'Bravo', status: 1 },
        ],
      },
      attendanceSession: {
        startedAt: 1000,
        // No endedAt.
        lastKnownMembers: {},
        tracker: {
          everPresent: { alpha: true, bravo: true },
          // Both left as the raid broke up, within the grace window of each other.
          lastSeen: { alpha: 20_000, bravo: 20_100 },
        },
      },
    });

    expect(night.rows.map((r) => r.bucket)).toEqual([
      AttendanceBucket.Present,
      AttendanceBucket.Present,
    ]);
  });

  it('still reports someone who genuinely left early on an unfinished night', () => {
    const night = bucketNight('X - Y', {
      importedData: {
        currentRoster: [
          { name: 'Early', status: 1 },
          { name: 'Stayed', status: 1 },
        ],
      },
      attendanceSession: {
        startedAt: 1000,
        lastKnownMembers: {},
        tracker: {
          everPresent: { early: true, stayed: true },
          lastSeen: { early: 2000, stayed: 20_000 },
        },
      },
    });

    expect(night.rows.map((r) => r.bucket)).toEqual([
      AttendanceBucket.LeftEarly,
      AttendanceBucket.Present,
    ]);
  });
});

describe('waitForStableFile', () => {
  it('returns once the size stops moving', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rfc-'));
    const path = join(dir, 'Raidify.lua');
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

describe('archived nights', () => {
  it('reads a night the addon set aside when a new roster was imported', () => {
    // The officer raids Wednesday, does not upload, then imports Thursday's roster on
    // Thursday afternoon. Before archiving, Wednesday was destroyed at that moment —
    // while the product tells officers they can upload whenever they like.
    const nights = [];
    const scope = {
      // Thursday's freshly imported roster, with no session yet.
      importedData: {
        raidInfo: { id: 'thursday', title: 'Thursday' },
        currentRoster: [{ name: 'Fenrik', status: 1 }],
      },
      attendanceHistory: [
        {
          startedAt: 1000,
          endedAt: 9000,
          lastKnownMembers: { wednesdayraider: true },
          tracker: {
            everPresent: { wednesdayraider: true },
            firstSeen: { wednesdayraider: 1000 },
            lastSeen: { wednesdayraider: 9000 },
          },
          // Wednesday's own roster travels with the night.
          roster: [{ name: 'Wednesdayraider', status: 1 }],
          raidInfo: { id: 'wednesday', title: 'Wednesday' },
        },
      ],
    };

    for (const archived of scope.attendanceHistory) {
      nights.push(
        bucketNight('Fenrik - Nightslayer', {
          attendanceSession: archived,
          importedData: { raidInfo: archived.raidInfo, currentRoster: archived.roster },
        }),
      );
    }

    expect(nights).toHaveLength(1);
    expect(nights[0]!.raidIdHint).toBe('wednesday');
    expect(nights[0]!.rows[0]!.name).toBe('Wednesdayraider');
    expect(nights[0]!.rows[0]!.bucket).toBe(AttendanceBucket.Present);
  });

  it('buckets an archived night against its own roster, not the current one', () => {
    // The whole point: the roster on disk now belongs to a different raid.
    const night = bucketNight('X - Y', {
      attendanceSession: {
        startedAt: 1000,
        endedAt: 9000,
        lastKnownMembers: {},
        tracker: { everPresent: {}, firstSeen: {}, lastSeen: {} },
      },
      importedData: {
        currentRoster: [{ name: 'Oldraider', status: 3 }],
      },
    });

    // Taken from the roster it was handed, and unresolved rather than benched — no
    // officer marked this one.
    expect(night.rows[0]!.name).toBe('Oldraider');
    expect(night.rows[0]!.bucket).toBe(AttendanceBucket.Unresolved);
  });
});

describe('stale nights', () => {
  const secondsAgo = (days: number) => Math.floor(Date.now() / 1000) - days * 86_400;

  function nightEndedDaysAgo(days: number) {
    return bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Fenrik', status: 1 }] },
      attendanceSession: {
        startedAt: secondsAgo(days),
        endedAt: secondsAgo(days) + 3 * 3600,
        lastKnownMembers: { fenrik: true },
        tracker: { everPresent: { fenrik: true }, firstSeen: { fenrik: secondsAgo(days) } },
      },
    });
  }

  it('does not call last Tuesday stale', () => {
    // "I forgot to upload last week" has to keep working.
    expect(nightEndedDaysAgo(7).stale).toBe(false);
  });

  it('calls a months-old session stale', () => {
    // The officer who led one raid on an alt in March still has that session on disk,
    // and every flush re-offers it. Uploaded, it would rewrite five-month-old history
    // or mint a standalone night everyone else is suddenly absent from.
    expect(nightEndedDaysAgo(150).stale).toBe(true);
  });

  it('treats a night with no usable timestamp as stale', () => {
    // Nothing to place it with, so nothing should send it unasked.
    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Fenrik', status: 1 }] },
      attendanceSession: { lastKnownMembers: { fenrik: true }, tracker: { everPresent: { fenrik: true } } },
    });

    expect(night.stale).toBe(true);
  });

  it('is still reported rather than hidden', () => {
    // The officer may genuinely want to send an old night. Marking it is the point;
    // dropping it silently would be the same silence this app keeps having to fix.
    const night = nightEndedDaysAgo(150);
    expect(night.rows.length).toBeGreaterThan(0);
  });
});

describe('officer bench marks', () => {
  it('reports a marked bench with who marked it and when', () => {
    // The mark is what makes a bench admissible at all — the server refuses one it
    // cannot attribute, because otherwise a waitlisted sign-up would earn full credit.
    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Kaya', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 9000,
        lastKnownMembers: {},
        tracker: { everPresent: {}, firstSeen: {}, lastSeen: {} },
        benchMarks: {
          kaya: { name: 'Kaya', markedBy: 'Torvald', markedAt: 1800, route: 'invite' },
        },
      },
    });

    const row = night.rows[0]!;
    expect(row.bucket).toBe(AttendanceBucket.Benched);
    expect(row.markedBy).toBe('Torvald');
    expect(row.markRoute).toBe('invite');
    expect(row.markedAt).toBe(new Date(1800 * 1000).toISOString());
  });

  it('keeps a sweep mark distinguishable from an invite-time one', () => {
    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Kaya', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 9000,
        lastKnownMembers: {},
        tracker: { everPresent: {} },
        benchMarks: { kaya: { markedBy: 'Torvald', markedAt: 8800, route: 'sweep' } },
      },
    });

    expect(night.rows[0]!.markRoute).toBe('sweep');
  });

  it('does not invent a mark for someone the addon merely did not see', () => {
    const night = bucketNight('X - Y', {
      importedData: { currentRoster: [{ name: 'Kaya', status: 1 }] },
      attendanceSession: {
        startedAt: 1000,
        endedAt: 9000,
        lastKnownMembers: {},
        tracker: { everPresent: {} },
      },
    });

    const row = night.rows[0]!;
    expect(row.bucket).toBe(AttendanceBucket.Absent);
    expect(row.markedBy ?? null).toBeNull();
  });
});
