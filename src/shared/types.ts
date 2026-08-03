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

export interface ParsedNight {
  /** AceDB character key, e.g. `Toon - Nightslayer`. */
  characterKey: string;
  raidIdHint: string | null;
  raidTitle: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The addon considers the night finished — it set an end time. */
  finished: boolean;
  rows: AttendanceRow[];
}
