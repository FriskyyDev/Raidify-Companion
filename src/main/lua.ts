import { LuaFactory } from 'wasmoon';

/**
 * Reading `Raidify.lua`.
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

/**
 * One factory for the process, not one per parse.
 *
 * `new LuaFactory()` instantiates a whole emscripten module — it reads and compiles
 * glue.wasm — and `lua.global.close()` frees the Lua state but not the WASM instance,
 * which only GC reclaims. Per-parse factories left ~130 MB of external memory churning,
 * and this ships as a 32-bit build with roughly 2 GB of address space, where each
 * abandoned WebAssembly.Memory holds address space until collected. Creating an engine
 * from an existing factory is cheap; creating the factory is not.
 */
let factory: LuaFactory | null = null;

function sharedFactory(): LuaFactory {
  factory ??= new LuaFactory();
  return factory;
}

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
  const lua = await sharedFactory().createEngine({ openStandardLibs: false });

  try {
    // No Promise.race against a timer here, and that is deliberate.
    //
    // `doString` runs the chunk synchronously inside WASM and can only yield through
    // coroutines, which do not exist with the standard library closed. So the JS thread
    // is *inside* WASM for the whole evaluation and a timer callback cannot run — the
    // previous timeout could never fire, and on the one path where it might have won it
    // would have closed the Lua state while the VM was still using it.
    //
    // The real guards are structural: the sandbox has no stdlib, so there is no `os`,
    // no `io` and no way to spin forever on anything but a hand-written loop, and a
    // SavedVariables file is table literals. A genuine defence against a hostile file
    // needs the parse off this thread entirely — see the note in README.
    await lua.doString(source);
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
