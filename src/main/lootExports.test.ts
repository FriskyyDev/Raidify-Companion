import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLootExports } from './lootExports';

describe('readLootExports', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rfc-loot-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(body: string): Promise<string> {
    const path = join(dir, 'Raidify_Loot.lua');
    await writeFile(path, body, 'utf8');
    return path;
  }

  it('returns null when the loot addon is not installed', async () => {
    // Not an error: most guilds do not run loot council.
    expect(await readLootExports(join(dir, 'nope.lua'))).toBeNull();
  });

  it('reads pending exports with their night id', async () => {
    const path = await write(`RaidifyLootDB = {
      ["usesLoot"] = true,
      ["pendingExports"] = {
        { ["nightId"] = "n-1", ["exportedAt"] = 1700000000, ["awards"] = 3,
          ["payload"] = "RAIDIFY:v1:lootawards:abc:1" },
      },
    }`);

    const result = await readLootExports(path);
    expect(result?.usesLoot).toBe(true);
    expect(result?.pending).toHaveLength(1);
    expect(result?.pending[0]!.nightId).toBe('n-1');
    expect(result?.pending[0]!.awards).toBe(3);
    expect(result?.pending[0]!.payload).toBe('RAIDIFY:v1:lootawards:abc:1');
    expect(result?.pending[0]!.exportedAt).toEqual(new Date(1700000000 * 1000));
  });

  it('drops entries with no payload rather than offering an empty upload', async () => {
    const path = await write(`RaidifyLootDB = {
      ["pendingExports"] = {
        { ["nightId"] = "n-1", ["awards"] = 2 },
        { ["nightId"] = "n-2", ["payload"] = "RAIDIFY:v1:lootawards:def:2" },
      },
    }`);

    const result = await readLootExports(path);
    expect(result?.pending.map((p) => p.nightId)).toEqual(['n-2']);
  });

  it('sorts newest first, and does not let an undated entry jump the queue', async () => {
    const path = await write(`RaidifyLootDB = {
      ["pendingExports"] = {
        { ["nightId"] = "old",   ["exportedAt"] = 1000, ["payload"] = "a" },
        { ["nightId"] = "undated",             ["payload"] = "b" },
        { ["nightId"] = "new",   ["exportedAt"] = 2000, ["payload"] = "c" },
      },
    }`);

    const result = await readLootExports(path);
    expect(result?.pending.map((p) => p.nightId)).toEqual(['new', 'old', 'undated']);
  });

  it('reports usesLoot false for a guild that has the addon but never used it', async () => {
    const path = await write(`RaidifyLootDB = { ["settings"] = {} }`);
    const result = await readLootExports(path);
    expect(result?.usesLoot).toBe(false);
    expect(result?.pending).toEqual([]);
  });

  it('survives a file with no pendingExports table at all', async () => {
    // Every build before this feature shipped. Must read as "nothing to send", not throw.
    const path = await write(`RaidifyLootDB = {
      ["usesLoot"] = true,
      ["settings"] = { ["lootQualityThreshold"] = 2 },
    }`);

    const result = await readLootExports(path);
    expect(result?.pending).toEqual([]);
  });
});
