import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against the class of bug that shipped once already: the built app referring to
 * a file the build does not emit.
 *
 * The preload was declared as `../preload/index.js` while electron-vite — correctly, given
 * `"type": "module"` — emitted `index.mjs`. Nothing failed loudly. Electron logged one
 * line to a console nobody sees, `window.companion` was undefined, and the window
 * rendered its static shell and then did nothing forever. `npm run package` succeeded
 * throughout, so CI was green on an app that could not work at all.
 *
 * These assertions read the actual build output rather than the source, because the
 * source was never wrong in a way TypeScript could see — the string matched a file that
 * simply did not exist.
 */

const MAIN = resolve('out/main/index.js');

describe('build output', () => {
  it.skipIf(!existsSync(MAIN))('references a preload file that exists on disk', () => {
    const built = readFileSync(MAIN, 'utf8');

    // The bundle keeps the literal, e.g. join(__dirname, "../preload/index.mjs").
    const match = built.match(/["'](\.\.\/preload\/[^"']+)["']/);
    expect(match, 'no preload path found in the built main process').not.toBeNull();

    const referenced = resolve(join(dirname(MAIN), match![1]!));
    expect(
      existsSync(referenced),
      `main references ${match![1]} but that file was not emitted. The app would launch ` +
        'with no preload, so window.companion would be undefined and the UI would sit ' +
        'there doing nothing.',
    ).toBe(true);
  });

  it.skipIf(!existsSync(MAIN))('exposes the bridge from the emitted preload', () => {
    // Belt to the braces above: the file existing is not the same as it being the
    // preload. If this ever stops matching, the renderer has no bridge again.
    const built = readFileSync(MAIN, 'utf8');
    const match = built.match(/["'](\.\.\/preload\/[^"']+)["']/);
    const preload = readFileSync(resolve(join(dirname(MAIN), match![1]!)), 'utf8');

    expect(preload).toContain('exposeInMainWorld');
    expect(preload).toContain('companion');
  });
});
