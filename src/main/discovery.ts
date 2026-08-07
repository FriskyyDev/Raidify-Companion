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
/**
 * The saved-variables file WoW actually writes.
 *
 * Named after the ADDON FOLDER (`Raidify`), not after the global the .toc declares
 * (`RaidifyDB`). We searched for `RaidifyDB.lua`, which the game never creates, so
 * discovery could not succeed on any machine — every officer got "the addon has not
 * written yet" no matter how many times it had.
 *
 * The global inside the file really is `RaidifyDB`; only the filename differs. See
 * `SAVED_VARIABLE_NAME` in lua parsing.
 */
export const SAVED_VARIABLES_FILE = 'Raidify.lua';

/**
 * The loot addon's file, when the guild runs loot council.
 *
 * A separate addon (`Raidify_Loot`) with its own saved variable, deliberately: a corrupt
 * loot table must not be able to take the roster and settings down with it. Same folder,
 * same naming rule — named after the addon folder, not after `RaidifyLootDB`.
 *
 * Optional. Most guilds will not have it, and its absence is not a problem to report.
 */
export const LOOT_SAVED_VARIABLES_FILE = 'Raidify_Loot.lua';

const FLAVOURS = [
  '_retail_',
  '_classic_era_',
  '_classic_',
  // TBC Anniversary realms install here. Raidify supports that content, so leaving the
  // folder off this list meant those raids were invisible to auto-detect.
  '_anniversary_',
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

/**
 * Subdirectories, including the ones Windows hides behind a link.
 *
 * `Dirent.isDirectory()` is false for an NTFS junction or a symlink, and a junction is
 * the standard way people relocate a WoW install to another drive. Relying on the Dirent
 * type made those installs invisible to auto-detect *and* to the manual browse path — the
 * app would tell someone there was no WoW in a folder they were looking at.
 *
 * So anything that is not obviously a file gets a `stat`, which follows the link.
 */
async function subdirectories(path: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    // Permission denied is not "nothing here", and reporting it as such is how an
    // officer ends up staring at a folder the app claims is empty.
    if ((error as NodeJS.ErrnoException)?.code === 'EACCES') throw error;
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;

    try {
      if ((await stat(join(path, entry.name))).isDirectory()) names.push(entry.name);
    } catch {
      // A broken link. Not a directory, not an error worth surfacing.
    }
  }

  return names;
}

/**
 * Every `Raidify.lua` under one install, across flavours and accounts.
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
      const path = join(accountRoot, account, 'SavedVariables', SAVED_VARIABLES_FILE);
      if (!(await exists(path))) continue;

      // Guarded: a file deleted between the check and here, or one we cannot read, must
      // not abort the whole scan and take every other candidate down with it.
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }

      // Sibling of the core file, so no second search — just ask whether it is there.
      const lootPath = join(accountRoot, account, 'SavedVariables', LOOT_SAVED_VARIABLES_FILE);

      found.push({
        installPath,
        flavour: flavour || '(install root)',
        account,
        path,
        lootPath: (await exists(lootPath)) ? lootPath : null,
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

  // The standard install locations, resolved against this machine's actual Program
  // Files paths rather than assumed to be on C:. This does NOT consult Battle.net's
  // product.db or the registry, so a non-default install — E:\Games\... — will not be
  // found here and has to be picked by hand. Worth doing properly one day; until then
  // this comment is the honest version.
  for (const envVar of ['ProgramFiles(x86)', 'ProgramFiles', 'ProgramW6432']) {
    const base = process.env[envVar];
    if (base) roots.add(join(base, 'World of Warcraft'));
  }

  const results: SavedVariablesCandidate[] = [];
  for (const root of roots) {
    try {
      if (!(await exists(root))) continue;
      results.push(...(await findSavedVariables(root)));
    } catch {
      // One unreadable root — a locked-down folder, a disconnected drive — must not
      // take the whole scan with it. A hand-picked folder still reports its error,
      // because there the user is looking straight at the thing that failed.
    }
  }

  // Two roots can resolve to the same file; keep the first sighting of each path.
  const seen = new Set<string>();
  return results
    .filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)))
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}
