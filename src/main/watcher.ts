import { watch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { readNights, waitForStableFile } from './savedVariables';
import type { ParsedNight } from '../shared/types';

/**
 * Noticing that a raid night finished.
 *
 * WoW only flushes SavedVariables on logout or `/reload`, so the interesting moment is a
 * single burst of writes rather than a steady trickle. That shapes everything here: one
 * flush produces several filesystem events, the file is large enough to be caught
 * mid-write, and the whole thing happens while the officer is looking at the game rather
 * than at us.
 *
 * The watch is on the *directory*, not the file. WoW writes by rename, which replaces
 * the inode — a watch bound to the old file stops firing after the first flush and then
 * reports nothing forever, which is exactly the silent failure this app cannot have.
 */

export interface WatcherEvents {
  /** A night parsed cleanly. Fires once per flush, per character with a session. */
  onNights: (nights: ParsedNight[]) => void;
  /** Something went wrong reading it. Surfaced, never swallowed. */
  onError: (error: Error) => void;

  /** The file read cleanly but held no usable night. Silence is a failure mode here. */
  onEmpty?: () => void;
}

export interface WatcherOptions {
  /** Full path to `RaidifyDB.lua`. */
  path: string;
  /** How long writes must stop before we read. */
  debounceMs?: number;
  /**
   * Size-stability settings passed to {@link waitForStableFile}. Exposed so tests can
   * run in milliseconds instead of seconds — a test whose budget is a second and a half
   * against a check that takes one and a quarter is a test that fails on a slow runner
   * and teaches people to re-run the build.
   */
  stability?: { intervalMs?: number; requiredStableChecks?: number; timeoutMs?: number };

  /** How long to wait before re-attaching a watch that died with its directory. */
  rearmMs?: number;
}

export class SavedVariablesWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private rearmTimer: NodeJS.Timeout | null = null;
  private reading = false;
  private missedWhileReading = false;

  /**
   * Set by stop(), and checked everywhere an event could still escape.
   *
   * Without it, stopping mid-read did not stop anything: the in-flight read still
   * emitted, and its `finally` could arm a fresh timer that fired against a stopped
   * watcher. Changing the watched folder in the UI therefore reported a night from the
   * old path as well as the new one — the double-upload the whole design forbids.
   */
  private stopped = false;

  constructor(
    private readonly options: WatcherOptions,
    private readonly events: WatcherEvents,
  ) {}

  start(): void {
    if (this.watcher) return;
    this.stopped = false;
    this.arm();
  }

  /**
   * Attach the filesystem watch, and keep trying if it is not attachable yet.
   *
   * The watch is on the directory rather than the file because WoW writes by rename and
   * a watch bound to the old inode stops firing after the first flush.
   *
   * But the directory itself can go away — a WoW repair, a Battle.net update, the user
   * moving the install, backup software. When that happens the FSWatcher either errors
   * once or quietly goes inert while staying non-null, and `start()` refuses to re-arm
   * because it thinks it is already watching. The officer dismisses one error and the
   * app is deaf for every raid night after, while still reporting `watching: true`.
   */
  private arm(): void {
    if (this.stopped) return;

    const directory = dirname(this.options.path);
    const target = basename(this.options.path);

    try {
      this.watcher = watch(directory, (_event, filename) => {
        // The `.bak` changes in the same breath as the real file; only one of them
        // should start a read, or every flush is handled twice.
        if (filename !== target) return;
        this.schedule();
      });
    } catch (error) {
      // The folder does not exist yet — a fresh install, or mid-repair. Not fatal.
      this.events.onError(error instanceof Error ? error : new Error(String(error)));
      this.rearmLater();
      return;
    }

    this.watcher.on('error', (error) => {
      this.events.onError(error as Error);
      this.watcher?.close();
      this.watcher = null;
      this.rearmLater();
    });
  }

  private rearmLater(): void {
    if (this.stopped || this.rearmTimer) return;
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = null;
      if (this.watcher) return;
      this.arm();
      // A directory that came back may already hold a finished night.
      void this.read();
    }, this.options.rearmMs ?? 30_000);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.rearmTimer) clearTimeout(this.rearmTimer);
    this.rearmTimer = null;
  }

  /** Read now, without waiting for a write — used on startup and by a manual refresh. */
  async readNow(): Promise<void> {
    await this.read();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.read(), this.options.debounceMs ?? 1_500);
  }

  private async read(): Promise<void> {
    if (this.stopped) return;

    // A flush landing mid-read must not be lost, and must not start a second read
    // against a file the first one is still consuming.
    if (this.reading) {
      this.missedWhileReading = true;
      return;
    }

    this.reading = true;
    try {
      await waitForStableFile(this.options.path, this.options.stability);
      const nights = await readNights(this.options.path);

      // Re-checked after the awaits: a stop that arrived while we were reading must
      // still suppress the result, or a watcher the officer replaced keeps reporting.
      if (this.stopped) return;

      if (nights.length > 0) {
        this.events.onNights(nights);
      } else {
        // Zero nights is not nothing happening. No session, no imported roster, no
        // RaidifyDB global — all produced total silence before, which is the failure
        // mode this app most needs to avoid.
        this.events.onEmpty?.();
      }
    } catch (error) {
      if (this.stopped) return;
      this.events.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.reading = false;
      if (this.missedWhileReading) {
        this.missedWhileReading = false;
        this.schedule();
      }
    }
  }
}
