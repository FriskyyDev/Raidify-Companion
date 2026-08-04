import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { Settings, UploadedNight } from '../shared/types';

/**
 * What the officer told us once and should never be asked again.
 *
 * Plain JSON, deliberately: none of it is a secret. The token lives in `secrets.ts`
 * behind the OS credential store; this file holds a guild id, a folder path and a list of
 * nights already sent — all of it readable from the officer's own screen anyway.
 *
 * The setup questions are asked once. An app that forgets which guild it reports for
 * every time it launches is an app the officer stops launching.
 *
 * The shapes live in `shared/types` because the UI renders them; this file is only the
 * reading and writing.
 */

/** Beyond this, the history is scrollback nobody reads and a file that only grows. */
const MAX_HISTORY = 200;

const DEFAULTS: Settings = {
  guildId: null,
  guildName: null,
  savedVariablesPath: null,
  installPath: null,
  autoWatch: true,
  uploaded: [],
};

const FILE = (): string => join(app.getPath('userData'), 'settings.json');

let cache: Settings | null = null;

export function loadSettings(): Settings {
  if (cache) return cache;

  const path = FILE();
  if (!existsSync(path)) {
    cache = { ...DEFAULTS };
    return cache;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
    cache = {
      ...DEFAULTS,
      ...parsed,
      // A hand-edited or half-written file must not take the app down on launch. Every
      // field is re-checked rather than trusted, because the type above is a claim about
      // what we wrote, not about what is on disk.
      guildId: typeof parsed.guildId === 'string' ? parsed.guildId : null,
      guildName: typeof parsed.guildName === 'string' ? parsed.guildName : null,
      savedVariablesPath:
        typeof parsed.savedVariablesPath === 'string' ? parsed.savedVariablesPath : null,
      installPath: typeof parsed.installPath === 'string' ? parsed.installPath : null,
      autoWatch: typeof parsed.autoWatch === 'boolean' ? parsed.autoWatch : true,
      uploaded: Array.isArray(parsed.uploaded)
        ? parsed.uploaded.filter((u): u is UploadedNight => typeof u?.key === 'string')
        : [],
    };
  } catch {
    // Corrupt settings are not worth a dialog. Fall back to defaults and let the officer
    // answer the setup questions again — annoying, and survivable.
    cache = { ...DEFAULTS };
  }

  return cache;
}

export function saveSettings(next: Partial<Settings>): Settings {
  const merged = { ...loadSettings(), ...next };
  merged.uploaded = merged.uploaded.slice(-MAX_HISTORY);
  cache = merged;

  const path = FILE();
  mkdirSync(dirname(path), { recursive: true });

  // Write-then-rename: the alternative is truncating the real file and then losing power
  // (or being killed by a Windows update) before the content lands, which turns "forgot a
  // preference" into "settings file is now zero bytes".
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(merged, null, 2), 'utf8');
  renameSync(temporary, path);

  return merged;
}

/** Record a night as sent. Replaces any earlier entry for the same night. */
export function rememberUpload(entry: UploadedNight): Settings {
  const rest = loadSettings().uploaded.filter((u) => u.key !== entry.key);
  return saveSettings({ uploaded: [...rest, entry] });
}

/** Test seam. The cache is process-wide and would otherwise leak between cases. */
export function resetSettingsCache(): void {
  cache = null;
}
