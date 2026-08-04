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

const companionPaths = Object.keys(document.paths ?? {}).filter((p) => p.includes('companion'));
if (!companionPaths.length) {
  console.error('No companion routes in this document — refusing to write a reference without them.');
  process.exit(1);
}

/**
 * Only the companion's own corner of the API.
 *
 * The full document is 248 paths and 328 schemas — every admin route, every internal DTO,
 * the whole shape of Raidify. This repo may be made public so that anyone worried about
 * an unsigned binary can read what it does, and a complete map of the private API is
 * exactly the kind of detail that must not travel with it.
 *
 * Narrowing costs nothing: the point of this file is noticing a change to the eight
 * endpoints the companion speaks to, and the other 240 could not produce a diff worth
 * reading anyway.
 */
const reference = {
  openapi: document.openapi,
  info: { title: document.info?.title, version: document.info?.version },
  paths: Object.fromEntries(companionPaths.map((p) => [p, document.paths[p]])),
  components: { schemas: collectSchemas(document, companionPaths) },
};

await writeFile(target, `${JSON.stringify(reference, null, 2)}\n`, 'utf8');
console.log(`wrote ${target}`);
console.log(`companion routes:\n  ${companionPaths.join('\n  ')}`);
console.log(`schemas kept: ${Object.keys(reference.components.schemas).length}`);

/** Every schema those paths reach, following $ref transitively. */
function collectSchemas(doc, paths) {
  const all = doc.components?.schemas ?? {};
  const kept = {};
  const queue = paths.flatMap((p) => refsIn(doc.paths[p]));

  while (queue.length) {
    const name = queue.pop();
    if (!all[name] || kept[name]) continue;
    kept[name] = all[name];
    queue.push(...refsIn(all[name]));
  }

  // Sorted, so a schema being added does not reshuffle the whole file and bury the change.
  return Object.fromEntries(Object.keys(kept).sort().map((k) => [k, kept[k]]));
}

function refsIn(node) {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(refsIn);

  return Object.entries(node).flatMap(([key, value]) =>
    key === '$ref' && typeof value === 'string' ? [value.split('/').pop()] : refsIn(value),
  );
}
