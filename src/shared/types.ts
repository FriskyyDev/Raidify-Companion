import type { AttendanceRow } from './contract';

/**
 * Types that cross the IPC boundary.
 *
 * They live here rather than beside the code that produces them because both sides of
 * the bridge need them, and a renderer importing from `src/main` is how the boundary
 * stops meaning anything.
 */

export interface SavedVariablesCandidate {
  /** The `World of Warcraft` folder itself. */
  installPath: string;
  /** e.g. `_classic_era_`. */
  flavour: string;
  /** The WTF account folder name. */
  account: string;
  /** Full path to `RaidifyDB.lua`. */
  path: string;
  /** So the UI can show which one is actually in use. */
  modifiedAt: Date;
  hasBackup: boolean;
}

/**
 * What came back from asking the officer to point at their WoW folder.
 *
 * Discriminated rather than a bare array, because those are three different facts and the
 * UI has three different things to say. Returning `[]` for all of them meant pressing
 * Cancel rendered "No Raidify saved-variables file found — that file only appears after
 * the addon has run at least once", which tells an officer their addon is broken because
 * they changed their mind about a folder picker.
 */
export type BrowseResult =
  | { outcome: 'cancelled' }
  | { outcome: 'found'; candidates: SavedVariablesCandidate[] }
  | { outcome: 'none'; searchedPath: string };

export interface ParsedNight {
  /** AceDB character key, e.g. `Toon - Nightslayer`. */
  characterKey: string;
  raidIdHint: string | null;
  raidTitle: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The addon considers the night finished — it set an end time. */
  finished: boolean;

  /**
   * Old enough that uploading it would be rewriting history rather than recording it.
   *
   * An officer who led one raid on an alt in March still has that session sitting in
   * their saved variables, and every flush of the file re-offers it. Uploaded, the
   * server would match it by date to a March raid and overwrite five-month-old
   * attendance, or mint a standalone March night that everyone else is suddenly 0/1 on.
   *
   * Still returned rather than hidden — the officer may genuinely want to send an old
   * night — but nothing should upload one without being asked.
   */
  stale: boolean;

  rows: AttendanceRow[];
}

export interface Settings {
  /** Which guild this machine reports for. Null until setup is done. */
  guildId: string | null;
  guildName: string | null;
  /** The `RaidifyDB.lua` we watch. */
  savedVariablesPath: string | null;
  /**
   * The `World of Warcraft` folder it was found under.
   *
   * Stored so the path can be re-discovered on the next launch rather than trusted. A
   * path is only ever read after this app has found it itself; a string sitting in a JSON
   * file is not that, and the difference matters for a value that becomes a file read and
   * a Lua evaluation.
   */
  installPath: string | null;
  /** Start watching as soon as the app opens, rather than waiting to be told. */
  autoWatch: boolean;
  /**
   * Nights already sent from this machine, newest last.
   *
   * Not a correctness mechanism — the server upserts, so a second send of the same night
   * changes nothing. This is so the list stops asking. Every flush of the saved-variables
   * file re-reads every session in it, and an app that offers the same finished night at
   * every launch until the officer manually clears it teaches them to ignore the list,
   * which is the one thing it must not do.
   */
  uploaded: UploadedNight[];
}

export interface UploadedNight {
  /** `characterKey|startedAt` — see `nightKey`. */
  key: string;
  uploadedAt: string;
  raidTitle: string | null;
  recorded: number;
  updated: number;
}
