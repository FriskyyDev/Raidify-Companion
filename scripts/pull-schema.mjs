#!/usr/bin/env node
/**
 * Refresh the reference copy of the API's OpenAPI document.
 *
 * The companion hand-writes the three types it actually uses (`src/shared/contract.ts`)
 * rather than generating a client — the surface is two endpoints, and a generator would
 * drag the whole schema in behind them. What this script buys is the ability to *notice*
 * a contract change: run it, look at the diff, update the types if the diff touches
 * anything companion-shaped.
 *
 * Deliberately not part of the build. A build that reaches across to another service is
 * a build that fails when that service is down.
 *
 *   node scripts/pull-schema.mjs [baseUrl]
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = (process.argv[2] ?? 'https://www.raidify.app').replace(/\/+$/, '');
const target = resolve('reference/openapi.json');

const candidates = ['/swagger/v1/swagger.json', '/openapi/v1.json', '/swagger/v1/openapi.json'];

let document = null;
for (const path of candidates) {
  try {
    const response = await fetch(`${baseUrl}${path}`);
    if (!response.ok) continue;
    document = await response.json();
    console.log(`fetched ${baseUrl}${path}`);
    break;
  } catch {
    /* try the next one */
  }
}

if (!document) {
  console.error(
    `Could not find an OpenAPI document under ${baseUrl}. Tried:\n  ${candidates.join('\n  ')}`,
  );
  process.exit(1);
}

// Pretty-printed and sorted so the diff is readable — the whole point is reviewing it.
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`wrote ${target}`);

const companionPaths = Object.keys(document.paths ?? {}).filter((p) => p.includes('companion'));
console.log(
  companionPaths.length
    ? `companion routes:\n  ${companionPaths.join('\n  ')}`
    : 'WARNING: no companion routes in this document.',
);
