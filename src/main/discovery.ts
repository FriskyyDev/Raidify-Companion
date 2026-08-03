import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SavedVariablesCandidate } from '../shared/types';

/**
 * Finding the WoW install, and the right account inside it.
 *
 * Auto-detection is a convenience, never an authority: every screen that uses this must
 * also let the officer point at a folder by hand. People move installs, run two of them,
 * and keep an old one around — guessing silently is how the companion ends up watching
 * a directory nobody raids from and reporting nothing, forever.
 */

/** Flavour folders, newest first — a modern install has several side by side. */
const FLAVOURS = [
  '_retail_',
  '_classic_era_',
  '_classic_',
  '_classic_beta_',
  '_classic_ptr_',
  '_ptr_',
  '_xptr_',
  '_beta_',
];

const COMMON_ROOTS = [
  'C:\\Program Files (x86)\\World of Warcraft',
  'C:\\Program Files\\World of Warcraft',
  'C:\\World of Warcraft',
  'D:\\World of Warcraft',
  'D:\\Games\\World of Warcraft',
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function subdirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Every `RaidifyDB.lua` under one install, across flavours and accounts.
 *
 * Sorted by last modified, newest first — on a machine with three accounts, the one
 * that raided on Tuesday is the one the officer means, and making them work that out
 * from folder names like `123456789#1` is a bad first five minutes.
 */
export async function findSavedVariables(installPath: string): Promise<SavedVariablesCandidate[]> {
  const found: SavedVariablesCandidate[] = [];

  // A path may point at the install root or at a flavour folder — both are things a
  // person reasonably picks when told to "find World of Warcraft".
  const flavourDirs = (await exists(join(installPath, 'WTF')))
    ? [{ flavour: '', base: installPath }]
    : (await subdirectories(installPath))
        .filter((name) => FLAVOURS.includes(name))
        .map((name) => ({ flavour: name, base: join(installPath, name) }));

  for (const { flavour, base } of flavourDirs) {
    const accountRoot = join(base, 'WTF', 'Account');
    for (const account of await subdirectories(accountRoot)) {
      const path = join(accountRoot, account, 'SavedVariables', 'RaidifyDB.lua');
      if (!(await exists(path))) continue;

      const info = await stat(path);
      found.push({
        installPath,
        flavour: flavour || '(install root)',
        account,
        path,
        modifiedAt: info.mtime,
        hasBackup: await exists(`${path}.bak`),
      });
    }
  }

  return found.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/**
 * Best-effort scan of the usual places.
 *
 * Deliberately shallow: no drive-wide search. Walking every disk to find a game folder
 * is the kind of thing antivirus takes an interest in, and an unsigned binary has no
 * reputation to spend on looking like a file scanner.
 */
export async function autoDetect(): Promise<SavedVariablesCandidate[]> {
  const roots = new Set(COMMON_ROOTS);

  // Whatever the launcher recorded, if anything.
  for (const envVar of ['ProgramFiles(x86)', 'ProgramFiles', 'ProgramW6432']) {
    const base = process.env[envVar];
    if (base) roots.add(join(base, 'World of Warcraft'));
  }

  const results: SavedVariablesCandidate[] = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    results.push(...(await findSavedVariables(root)));
  }

  // Two roots can resolve to the same file; keep the first sighting of each path.
  const seen = new Set<string>();
  return results
    .filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)))
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}
