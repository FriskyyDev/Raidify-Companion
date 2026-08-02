import { describe, expect, it } from 'vitest';
import { LuaParseError, readSavedVariable } from './lua';

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

    // A Lua table with keys 1..n arrives as a real JS array, so the indices shift by
    // one. Easy to write `roster[1]` for the first entry and get the second.
    expect(Array.isArray(session.roster)).toBe(true);
    expect(session.roster[0].name).toBe('Toon');
    expect(session.roster[1].bucket).toBe('benched');
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

  it('has no standard library to reach for', async () => {
    // The file comes off disk and anything could have written it. `os` and `io` must not
    // exist inside the sandbox.
    await expect(readSavedVariable('RaidifyDB = os.time()', 'RaidifyDB')).rejects.toBeInstanceOf(
      LuaParseError,
    );
  });
});
