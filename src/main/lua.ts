import { LuaFactory } from 'wasmoon';

/**
 * Reading `RaidifyDB.lua`.
 *
 * The file is Lua source, not JSON — an AceDB table literal with comments, `["key"]`
 * indices, `[1] =` array entries, nested tables and Lua string escapes. So it is
 * evaluated as Lua, in a sandbox with no standard library, and the resulting table is
 * walked.
 *
 * Do NOT be tempted to regex `attendanceSession` out of it. That breaks the first time a
 * character name contains a bracket or a guild note contains a quote, and it breaks
 * silently, on someone else's raid night.
 */

/** Guards against a truncated or hostile file wedging the app. */
const EVAL_TIMEOUT_MS = 10_000;

/**
 * Read a Lua list as an array, whichever shape wasmoon happened to produce.
 *
 * Always use this for anything the addon writes with `table.insert` or `[n] =`. See the
 * warning above for why trusting `Array.isArray` here is a raid-night bug waiting for a
 * roster of the wrong size.
 */
export function toArray<T = unknown>(value: unknown): T[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const out: T[] = [];

  // Lua lists are 1-based and contiguous; stop at the first gap rather than pulling in
  // unrelated string keys from a table that is not a list at all.
  for (let i = 1; Object.prototype.hasOwnProperty.call(record, String(i)); i++) {
    out.push(record[String(i)] as T);
  }

  return out;
}

export class LuaParseError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LuaParseError';
  }
}

/**
 * Evaluate a SavedVariables file and return the named global.
 *
 * The engine gets no stdlib: no `io`, no `os`, no `require`. A SavedVariables file is
 * assignments of table literals and needs none of it, and this file arrives from disk
 * where anything could have written it.
 *
 * ⚠️ **Never index the result of a Lua list directly — use {@link toArray}.** A `1..n`
 * table comes back as *either* a JS array (0-indexed, so the addon's `[1]` is `[0]`) or
 * a plain object keyed `"1".."n"`, and which one you get depends on the table's size.
 * Measured with wasmoon 1.16: 1–2 array, 3–4 object, 5–6 array, 7–8 object, 9 array,
 * 40 array. That follows Lua's internal array/hash split, so it is not a bug to wait
 * out — it means a five-man roster and a twenty-five-man roster parse to different
 * shapes, and a fixture small enough to be convenient hides it.
 */
export async function readSavedVariable<T = unknown>(
  source: string,
  globalName: string,
): Promise<T | null> {
  const factory = new LuaFactory();
  const lua = await factory.createEngine({ openStandardLibs: false });

  try {
    const done = lua.doString(source);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new LuaParseError('Timed out reading the saved variables file.')),
        EVAL_TIMEOUT_MS,
      ),
    );

    await Promise.race([done, timeout]);
    return (lua.global.get(globalName) as T | undefined) ?? null;
  } catch (error) {
    if (error instanceof LuaParseError) throw error;
    // A partial file is the normal case, not an exceptional one: WoW writes
    // SavedVariables by rename and a poll can catch it mid-write. The caller retries,
    // or falls back to the `.lua.bak` the game leaves behind.
    throw new LuaParseError(
      'That saved variables file could not be read as Lua — it may have been caught mid-write.',
      error,
    );
  } finally {
    lua.global.close();
  }
}
