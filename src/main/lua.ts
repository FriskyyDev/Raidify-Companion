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
 * ⚠️ **Indices shift.** A Lua table whose keys are `1..n` comes back as a real JS array,
 * so the addon's `roster[1]` is `roster[0]` here. Writing `[1]` for the first entry is
 * the obvious mistake and it silently reads the second raider instead — which, in an
 * attendance file, means quietly recording the wrong person.
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
