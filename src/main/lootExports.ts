/**
 * Reading `Raidify_Loot.lua`.
 *
 * The loot addon hands us finished export strings — the same `RAIDIFY:v1:lootawards:...`
 * an officer would otherwise copy out of a window and paste into the website. We never
 * decode them. The server already knows how, and re-implementing deflate and the checksum
 * here would mean two implementations of one wire format that can silently disagree.
 *
 * So this file does almost nothing on purpose: find the strings, carry enough metadata to
 * label them in the UI and deduplicate them, and forward them untouched.
 */

import { readFile } from 'node:fs/promises';
import { readSavedVariable } from './lua';
import type { PendingLootExport } from '../shared/types';

/** The global the loot addon declares. The FILE is `Raidify_Loot.lua`; these differ. */
const LOOT_GLOBAL = 'RaidifyLootDB';

export interface LootFileContents {
  /** Whether this guild uses loot council at all. Drives whether we show anything. */
  usesLoot: boolean;
  pending: PendingLootExport[];
}

/** WoW writes seconds; JS wants milliseconds. Nil and 0 both mean "not set". */
function asDate(value: unknown): Date | null {
  return typeof value === 'number' && value > 0 ? new Date(value * 1000) : null;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Read the loot file, if there is one.
 *
 * Returns `null` rather than throwing when the file is missing: most guilds do not run
 * loot council, and "this addon is not installed" is not an error worth surfacing.
 */
export async function readLootExports(path: string): Promise<LootFileContents | null> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  const db = await readSavedVariable<Record<string, unknown>>(source, LOOT_GLOBAL);
  if (!db) return null;

  const rawPending = Array.isArray(db.pendingExports) ? db.pendingExports : [];

  const pending: PendingLootExport[] = [];
  for (const entry of rawPending) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;

    // The string is the only field we cannot do without — everything else is labelling.
    if (typeof row.payload !== 'string' || row.payload === '') continue;

    pending.push({
      nightId: typeof row.nightId === 'string' ? row.nightId : null,
      exportedAt: asDate(row.exportedAt),
      startedAt: asDate(row.startedAt),
      endedAt: asDate(row.endedAt),
      awards: asCount(row.awards),
      payload: row.payload,
    });
  }

  // Newest first, matching how the addon inserts them and how the nights list already
  // reads. An entry with no timestamp sorts last rather than jumping to the top.
  pending.sort((a, b) => (b.exportedAt?.getTime() ?? 0) - (a.exportedAt?.getTime() ?? 0));

  return { usesLoot: db.usesLoot === true, pending };
}
