import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { autoDetect, findSavedVariables } from './discovery';

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

describe('autoDetect on Linux', () => {
  const realPlatform = process.platform;
  const realHome = process.env.HOME;

  const setPlatform = (value: string) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  afterEach(() => {
    setPlatform(realPlatform);
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  });

  /**
   * Linux was excluded from the build for a while on the grounds that Wine prefix discovery
   * was the fiddliest part of shipping it. This is that part: an install inside a Steam
   * Proton prefix, found without the officer typing a path.
   */
  it('finds an install inside a Steam Proton prefix', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rfc-linux-'));
    const install = join(
      home,
      '.steam/steam/steamapps/compatdata/2769240/pfx/drive_c',
      'Program Files (x86)/World of Warcraft',
    );
    const dir = join(install, '_classic_era_', 'WTF', 'Account', 'PROTON#1', 'SavedVariables');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'Raidify.lua'), 'RaidifyDB = {}', 'utf8');

    setPlatform('linux');
    process.env.HOME = home;

    const found = await autoDetect();

    expect(found.map((f) => f.account)).toContain('PROTON#1');
  });

  it('finds an install inside a Lutris prefix', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rfc-linux-'));
    const install = join(home, 'Games/battlenet/drive_c', 'Program Files (x86)/World of Warcraft');
    const dir = join(install, '_retail_', 'WTF', 'Account', 'LUTRIS#1', 'SavedVariables');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'Raidify.lua'), 'RaidifyDB = {}', 'utf8');

    setPlatform('linux');
    process.env.HOME = home;

    expect((await autoDetect()).map((f) => f.account)).toContain('LUTRIS#1');
  });

  /**
   * The Windows sweep must not run on Linux. Those paths cannot exist there, and a
   * `C:\` string is not something to spend a filesystem call on per launch.
   */
  it('does not fall back to Windows roots', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rfc-linux-'));
    setPlatform('linux');
    process.env.HOME = home;
    process.env['ProgramFiles(x86)'] = home;

    expect(await autoDetect()).toEqual([]);
  });
});
