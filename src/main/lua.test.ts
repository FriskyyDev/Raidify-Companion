import { describe, expect, it } from 'vitest';
import { LuaParseError, readSavedVariable, toArray } from './lua';

/**
 * The parser exists because regexing a SavedVariables file breaks on real data. These
 * tests are the specific shapes that break it.
 */
describe('readSavedVariable', () => {
  it('reads an AceDB-shaped table', async () => {
    const source = `
      -- WoW writes a comment header like this one.
      RaidifyDB = {
        ["profileKeys"] = {
          ["Toon - Nightslayer"] = "Default",
        },
        ["char"] = {
          ["Toon - Nightslayer"] = {
            ["attendanceSession"] = {
              ["startedAt"] = 1754000000,
              ["roster"] = {
                [1] = { ["name"] = "Toon", ["bucket"] = "present" },
                [2] = { ["name"] = "Alt", ["bucket"] = "benched" },
              },
            },
          },
        },
      }
    `;

    const db = await readSavedVariable<Record<string, any>>(source, 'RaidifyDB');
    const session = db?.char['Toon - Nightslayer'].attendanceSession;
    expect(session.startedAt).toBe(1754000000);

    // Through toArray, because the raw shape is not dependable — see below.
    const roster = toArray<{ name: string; bucket: string }>(session.roster);
    expect(roster[0]!.name).toBe('Toon');
    expect(roster[1]!.bucket).toBe('benched');
  });

  it('survives the characters a regex would choke on', async () => {
    // A bracket in a name and a quote in a note are exactly the two cases that make
    // pattern-matching this file a slow-motion bug.
    const source = String.raw`
      RaidifyDB = {
        ["notes"] = {
          ["Toon[Main]"] = "said \"sit this one out\"",
          ["Backslash"] = "one\\two",
        },
      }
    `;

    const db = await readSavedVariable<Record<string, any>>(source, 'RaidifyDB');
    expect(db?.notes['Toon[Main]']).toBe('said "sit this one out"');
    expect(db?.notes['Backslash']).toBe('one\\two');
  });

  it('returns null when the global is absent rather than inventing one', async () => {
    expect(await readSavedVariable('SomeOtherAddonDB = { }', 'RaidifyDB')).toBeNull();
  });

  it('reports a truncated file as a parse failure, not a corrupt night', async () => {
    // WoW writes by rename; a poll can catch the file mid-write. The caller retries or
    // falls back to the .lua.bak — it must not conclude that nobody raided.
    await expect(readSavedVariable('RaidifyDB = { ["char"] = {', 'RaidifyDB')).rejects.toBeInstanceOf(
      LuaParseError,
    );
  });

  it('hands back list tables in a shape that depends on their size', async () => {
    // Not a test of our code — a test of the assumption `toArray` exists to defend
    // against. If a future wasmoon makes this consistent, this test fails and the
    // workaround can be reconsidered. Until then: a 5-man roster and a 7-man roster
    // genuinely parse to different JS types.
    const shapes = await Promise.all(
      [2, 3, 7, 40].map(async (n) => {
        const entries = Array.from({ length: n }, (_, i) => `[${i + 1}]={n=${i + 1}}`).join(',');
        const table = await readSavedVariable(`T = { ${entries} }`, 'T');
        return { n, isArray: Array.isArray(table) };
      }),
    );

    // The point is that these are not all the same.
    expect(new Set(shapes.map((s) => s.isArray)).size).toBe(2);
  });

  it('reads a list table as an array whichever shape it arrived in', async () => {
    for (const n of [1, 3, 7, 25, 40]) {
      const entries = Array.from({ length: n }, (_, i) => `[${i + 1}]={n=${i + 1}}`).join(',');
      const table = await readSavedVariable(`T = { ${entries} }`, 'T');
      const list = toArray<{ n: number }>(table);
      expect(list).toHaveLength(n);
      expect(list[0]!.n).toBe(1);
      expect(list[n - 1]!.n).toBe(n);
    }
  });

  it('does not scoop up string keys from a table that is not a list', () => {
    expect(toArray({ name: 'Toon', realm: 'Nightslayer' })).toEqual([]);
    // Stops at the first gap rather than inventing entries.
    expect(toArray({ '1': 'a', '2': 'b', '4': 'd' })).toEqual(['a', 'b']);
    expect(toArray(undefined)).toEqual([]);
  });

  it('has no standard library to reach for', async () => {
    // The file comes off disk and anything could have written it. `os` and `io` must not
    // exist inside the sandbox.
    await expect(readSavedVariable('RaidifyDB = os.time()', 'RaidifyDB')).rejects.toBeInstanceOf(
      LuaParseError,
    );
  });
});
