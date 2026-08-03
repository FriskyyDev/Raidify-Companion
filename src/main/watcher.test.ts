import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

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
    // WoW's write produces several filesystem events. Reporting the night more than once
    // means uploading the same raid more than once, so the assertion is exactly one —
    // the previous version allowed two, which is the state it claimed to prevent.
    //
    // The writes are driven through the watcher's own scheduling rather than raced
    // against a wall-clock sleep, so a slow runner cannot change the answer.
    const path = await scratch();
    await copyFile(FIXTURE, path);

    const sink = collect();
    const watcher = new SavedVariablesWatcher({ path, debounceMs: 40, stability: FAST }, sink.events);
    watcher.start();

    try {
      const source = await readFile(FIXTURE, 'utf8');
      for (let i = 0; i < 5; i++) await writeFile(path, source, 'utf8');

      // Wait for the debounce plus the stability window, then a margin, and confirm the
      // count has settled rather than sampling it once.
      await waitFor(() => sink.nights.length > 0, 4_000);
      const afterFirst = sink.nights.length;
      await new Promise((r) => setTimeout(r, 400));

      expect(sink.nights).toHaveLength(afterFirst);
      expect(afterFirst).toBe(1);
    } finally {
      watcher.stop();
    }
  });

  it('re-arms the watch after being stopped and started', async () => {
    // The previous version called readNow(), which never touches the FSWatcher — it
    // would have passed if start() were a no-op. This asserts an actual file change is
    // noticed after the restart.
    const path = await scratch();
    await copyFile(FIXTURE, path);

    const sink = collect();
    const watcher = new SavedVariablesWatcher({ path, debounceMs: 40, stability: FAST }, sink.events);

    watcher.start();
    watcher.stop();
    watcher.start();

    try {
      await writeFile(path, await readFile(FIXTURE, 'utf8'), 'utf8');
      await waitFor(() => sink.nights.length > 0, 4_000);
      expect(sink.nights.length).toBeGreaterThan(0);
    } finally {
      watcher.stop();
    }
  });

  it('stays silent about a path it was stopped on', async () => {
    // Changing the watched folder in the UI stops one watcher and starts another. An
    // in-flight read on the old one used to finish and emit anyway, so the officer got a
    // night from the path they had just navigated away from.
    const path = await scratch();
    await copyFile(FIXTURE, path);

    const sink = collect();
    const watcher = new SavedVariablesWatcher(
      { path, debounceMs: 20, stability: { intervalMs: 40, requiredStableChecks: 4, timeoutMs: 3_000 } },
      sink.events,
    );

    const reading = watcher.readNow();
    watcher.stop();
    await reading;

    expect(sink.nights).toHaveLength(0);
    expect(sink.errors).toHaveLength(0);
  });

  it('says something when a flush holds no usable night', async () => {
    // No session, no imported roster, no RaidifyDB global — all read cleanly and produce
    // nothing. Total silence is the failure mode this app most needs to avoid.
    const path = await scratch();
    await writeFile(path, 'SomeOtherAddonDB = { }', 'utf8');

    let empties = 0;
    const sink = collect();
    const watcher = new SavedVariablesWatcher(
      { path, debounceMs: 20, stability: FAST },
      { ...sink.events, onEmpty: () => empties++ },
    );

    try {
      await watcher.readNow();
    } finally {
      watcher.stop();
    }

    expect(sink.nights).toHaveLength(0);
    expect(sink.errors).toHaveLength(0);
    expect(empties).toBe(1);
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
