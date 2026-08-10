import { app } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { homedir, release, type } from 'node:os';
import { join } from 'node:path';

/**
 * A log the officer can actually hand us.
 *
 * There was nothing here before: no file, no crash handlers, and no stack traces. When
 * something went wrong the officer saw one sentence in the UI, the stack died in the main
 * process, and the only bug report anyone could write was "it did not work". That is
 * unfixable at a distance, and this app runs on a machine we will never see, against a folder
 * layout we cannot reproduce, at the end of a raid night nobody wants to spend debugging.
 *
 * Deliberately not a telemetry pipeline. Nothing leaves the machine on its own. The file sits
 * in the app's own data folder and the UI gives one button to copy it, so sharing is a thing
 * the officer chooses to do, having been able to read it first.
 */

const MAX_BYTES = 512 * 1024;
/** Lines kept in memory for the copy-to-clipboard report, which nobody will read past. */
const REPORT_LINES = 400;

let logPath: string | null = null;
let ready = false;

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Strip anything that should not travel in a bug report.
 *
 * The token is the sharp one: it uploads attendance for the officer's guild, and a report
 * pasted into a Discord channel is a report published. Home directories go too, because the
 * Windows path to a WoW install contains the account name and there is no reason for that to
 * be in a file the officer is being encouraged to share.
 */
export function redact(text: string): string {
  let out = text;

  const home = homedir();
  if (home) {
    // Both separators: paths reach here from Node (backslashes) and from URLs (forward).
    out = out.split(home).join('~');
    out = out.split(home.replace(/\\/g, '/')).join('~');
  }

  // Bearer tokens and anything else long and opaque next to a token-ish word.
  //
  // The optional second `Bearer` matters: on `Authorization: Bearer abc.def`, a pattern
  // without it consumes the word "Bearer" as the value and leaves the actual token sitting
  // in the report. Caught by a test, which is the only reason this is right.
  out = out.replace(
    /\b(Authorization|Bearer|token)\b\s*[:=]?\s*(?:Bearer\s+)?\S+/gi,
    '$1 [redacted]',
  );

  return out;
}

function timestamp(): string {
  return new Date().toISOString();
}

/** One-time header, so a pasted report answers "which build, on what" without being asked. */
function header(): string {
  const versions = process.versions;
  return [
    '--- Raidify Companion diagnostics ---',
    `app        ${app.getVersion()}${app.isPackaged ? '' : ' (development)'}`,
    `electron   ${versions.electron}  chrome ${versions.chrome}  node ${versions.node}`,
    `os         ${type()} ${release()} ${process.arch}`,
    `started    ${timestamp()}`,
    '-------------------------------------',
  ].join('\n');
}

/** Roll the file over rather than letting a loop fill a disk. Keeps exactly one old copy. */
function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // Missing file is the normal first-run case. A locked one means we keep appending, which
    // is better than losing the write we were about to make.
  }
}

export function initDiagnostics(): void {
  if (ready) return;
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'companion.log');
    rotateIfLarge(logPath);
    appendFileSync(logPath, `\n${header()}\n`, 'utf8');
    ready = true;
  } catch {
    // A log we cannot write must never be the reason the app fails to start. Every call
    // below no-ops from here.
    logPath = null;
  }
}

/**
 * Record something. Errors carry their stack; everything else carries its message.
 *
 * Never throws. A logger that can take the app down with it is worse than no logger.
 */
export function log(level: LogLevel, message: string, detail?: unknown): void {
  if (!logPath) return;
  try {
    let line = `${timestamp()} ${level.toUpperCase().padEnd(5)} ${message}`;

    if (detail instanceof Error) {
      line += `\n  ${detail.name}: ${detail.message}`;
      if (detail.stack) {
        // Drop the first stack line: it repeats the name and message we just wrote.
        const frames = detail.stack.split('\n').slice(1).join('\n');
        line += `\n${frames}`;
      }
      const cause = (detail as { cause?: unknown }).cause;
      if (cause) line += `\n  caused by: ${String(cause)}`;
    } else if (detail !== undefined) {
      try {
        line += ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
      } catch {
        line += ' [detail not serialisable]';
      }
    }

    appendFileSync(logPath, `${redact(line)}\n`, 'utf8');
    rotateIfLarge(logPath);
  } catch {
    /* a failed write is not worth a second failure */
  }
}

export const logInfo = (message: string, detail?: unknown): void => log('info', message, detail);
export const logWarn = (message: string, detail?: unknown): void => log('warn', message, detail);
export const logError = (message: string, detail?: unknown): void => log('error', message, detail);

/** Where the file lives, for the "open log folder" button. Null when logging never started. */
export function diagnosticsDirectory(): string | null {
  return logPath ? join(app.getPath('userData'), 'logs') : null;
}

/**
 * The report the officer copies: a fresh header plus the tail of the log.
 *
 * Rebuilt rather than read from the top of the file, because the useful part is always the
 * end and a report nobody can paste into Discord is a report nobody sends.
 */
export function buildReport(): string {
  const parts = [header()];

  if (!logPath || !existsSync(logPath)) {
    parts.push('(no log file — diagnostics could not be written on this machine)');
    return parts.join('\n');
  }

  try {
    const lines = readFileSync(logPath, 'utf8').split('\n');
    const tail = lines.slice(-REPORT_LINES);
    if (lines.length > REPORT_LINES) {
      parts.push(`(showing the last ${REPORT_LINES} of ${lines.length} lines)`);
    }
    parts.push(tail.join('\n'));
  } catch (error) {
    parts.push(`(could not read the log: ${String(error)})`);
  }

  // Redacted again on the way out. The file is already clean, but this is the path that ends
  // up on a clipboard and then in somebody else's channel, so it gets the belt and braces.
  return redact(parts.join('\n'));
}

/**
 * Install process-wide handlers.
 *
 * Without these an unhandled rejection in the main process is invisible: Electron prints it
 * to a console nobody is attached to and the officer sees an app that simply stopped doing
 * anything. Logged rather than shown, because the officer cannot act on a stack trace — the
 * UI tells them what to do, and the file tells us why.
 */
export function captureProcessErrors(): void {
  process.on('uncaughtException', (error) => {
    logError('Uncaught exception in the main process', error);
  });
  process.on('unhandledRejection', (reason) => {
    logError(
      'Unhandled promise rejection in the main process',
      reason instanceof Error ? reason : new Error(String(reason)),
    );
  });
}
