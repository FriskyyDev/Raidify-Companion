/**
 * Start the real app and confirm the renderer can actually reach it.
 *
 * This exists because the app once shipped completely dead: the main process referenced
 * a preload filename the build did not emit, so `window.companion` was undefined and the
 * window rendered its shell and then did nothing forever. Typecheck, unit tests and
 * `electron-builder` were all green throughout, because none of them ever started it.
 *
 * It runs `out/main/index.js` itself — the actual entry point, with the actual window
 * config and the actual IPC handlers — rather than a harness that mirrors them. A mirror
 * would have drifted exactly the way the original bug did and reported success.
 */
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const entry = join(root, 'out', 'main', 'index.js');

if (!existsSync(entry)) {
  console.error(`SMOKE FAIL: ${entry} does not exist — run npm run build first.`);
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const electron = require('electron');
const binary = typeof electron === 'string' ? electron : String(electron);

const child = spawn(binary, [entry], {
  env: { ...process.env, RAIDIFY_SMOKE: '1' },
  stdio: 'inherit',
});

const timer = setTimeout(() => {
  console.error('SMOKE FAIL: the app did not report within 90s.');
  child.kill();
  process.exit(1);
}, 90_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  if (code !== 0) console.error(`SMOKE FAIL: the app exited with ${code}.`);
  process.exit(code ?? 1);
});
