import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSavedVariables } from './discovery';

const FIXTURE_INSTALL = resolve('fixtures/wow');

describe('findSavedVariables', () => {
  it('finds the saved variables under a flavour folder', async () => {
    const found = await findSavedVariables(FIXTURE_INSTALL);

    expect(found).toHaveLength(1);
    expect(found[0]!.flavour).toBe('_classic_era_');
    expect(found[0]!.account).toBe('TESTACCOUNT#1');
    expect(found[0]!.path.endsWith('Raidify.lua')).toBe(true);
  });

  it('also accepts being pointed straight at a flavour folder', async () => {
    // People told to "find World of Warcraft" pick either level, and being wrong about
    // which one they meant is not a good reason to tell them the folder is empty.
    const found = await findSavedVariables(join(FIXTURE_INSTALL, '_classic_era_'));
    expect(found).toHaveLength(1);
    expect(found[0]!.account).toBe('TESTACCOUNT#1');
  });

  it('lists the most recently used account first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rfc-wow-'));

    for (const account of ['OLD#1', 'RECENT#1']) {
      const dir = join(root, '_classic_era_', 'WTF', 'Account', account, 'SavedVariables');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'Raidify.lua'), 'RaidifyDB = {}', 'utf8');
      // Ensure a distinguishable mtime between the two writes.
      await new Promise((r) => setTimeout(r, 20));
    }

    const found = await findSavedVariables(root);
    expect(found.map((f) => f.account)).toEqual(['RECENT#1', 'OLD#1']);
  });

  it('returns nothing rather than throwing when there is no install there', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'rfc-empty-'));
    expect(await findSavedVariables(empty)).toEqual([]);
  });
});
