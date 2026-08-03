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
}

export class SavedVariablesWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private missedWhileReading = false;

  constructor(
    private readonly options: WatcherOptions,
    private readonly events: WatcherEvents,
  ) {}

  start(): void {
    if (this.watcher) return;

    const directory = dirname(this.options.path);
    const target = basename(this.options.path);

    this.watcher = watch(directory, (_event, filename) => {
      // The `.bak` changes in the same breath as the real file; only one of them should
      // start a read, or every flush is handled twice.
      if (filename !== target) return;
      this.schedule();
    });

    this.watcher.on('error', (error) => this.events.onError(error as Error));
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Read now, without waiting for a write — used on startup and by a manual refresh. */
  async readNow(): Promise<void> {
    await this.read();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.read(), this.options.debounceMs ?? 1_500);
  }

  private async read(): Promise<void> {
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
      if (nights.length > 0) this.events.onNights(nights);
    } catch (error) {
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
