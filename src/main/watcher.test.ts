import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedNight } from '../shared/types';
import { SavedVariablesWatcher } from './watcher';

const FIXTURE = resolve(
  'fixtures/wow/_classic_era_/WTF/Account/TESTACCOUNT#1/SavedVariables/RaidifyDB.lua',
);

/** Milliseconds, not seconds — the production defaults would make these tests race the clock. */
const FAST = { intervalMs: 5, requiredStableChecks: 2, timeoutMs: 3_000 };

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rfc-watch-'));
  return join(dir, 'RaidifyDB.lua');
}

function collect() {
  const nights: ParsedNight[][] = [];
  const errors: Error[] = [];
  return {
    nights,
    errors,
    events: {
      onNights: (n: ParsedNight[]) => nights.push(n),
      onError: (e: Error) => errors.push(e),
    },
  };
}

describe('SavedVariablesWatcher', () => {
  it('reads what is already on disk without waiting for a write', async () => {
    // The interesting flush may have happened while the app was closed. A companion
    // that only notices future raids is half a companion.
    const path = await scratch();
    await copyFile(FIXTURE, path);

    const sink = collect();
    const watcher = new SavedVariablesWatcher({ path, debounceMs: 20, stability: FAST }, sink.events);
    try {
      await watcher.readNow();
    } finally {
      watcher.stop();
    }

    expect(sink.errors).toHaveLength(0);
    expect(sink.nights).toHaveLength(1);
    expect(sink.nights[0]![0]!.rows).toHaveLength(6);
  });

  it('collapses one flush into a single read', async () => {
    // WoW's write produces several filesystem events. Reporting the night six times
    // would mean six uploads of the same raid.
    const path = await scratch();
    await copyFile(FIXTURE, path);

    const sink = collect();
    const watcher = new SavedVariablesWatcher({ path, debounceMs: 60, stability: FAST }, sink.events);
    watcher.start();

    try {
      const source = await import('node:fs/promises').then((fs) => fs.readFile(FIXTURE, 'utf8'));
      for (let i = 0; i < 5; i++) {
        await writeFile(path, source, 'utf8');
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 1_500));
    } finally {
      watcher.stop();
    }

    expect(sink.errors).toHaveLength(0);
    expect(sink.nights.length).toBeLessThanOrEqual(2);
    expect(sink.nights.length).toBeGreaterThanOrEqual(1);
  });

  it('reports a read failure instead of going quiet', async () => {
    // Silence is the failure mode that makes an officer stop trusting the upload, so a
    // broken file has to surface as an error rather than as nothing happening.
    const path = await scratch();
    await writeFile(path, 'RaidifyDB = { ["char"] = {', 'utf8');

    const sink = collect();
    const watcher = new SavedVariablesWatcher({ path, debounceMs: 20, stability: FAST }, sink.events);
    try {
      await watcher.readNow();
    } finally {
      watcher.stop();
    }

    expect(sink.nights).toHaveLength(0);
    expect(sink.errors).toHaveLength(1);
  });

  it('survives being stopped and started again', async () => {
    const path = await scratch();
    await copyFile(FIXTURE, path);

    const sink = collect();
    const watcher = new SavedVariablesWatcher({ path, debounceMs: 20, stability: FAST }, sink.events);
    watcher.start();
    watcher.stop();
    watcher.start();
    try {
      await watcher.readNow();
    } finally {
      watcher.stop();
    }

    expect(sink.nights).toHaveLength(1);
  });
});
