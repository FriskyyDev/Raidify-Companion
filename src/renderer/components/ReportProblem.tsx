import { useState } from 'react';

type SendState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; reportId: string }
  | { kind: 'failed'; message: string };

/**
 * The one place an officer goes when something has gone wrong.
 *
 * Before this existed, a failure produced one sentence in the UI and a stack trace that died
 * in the main process. The only bug report anybody could write was "it did not work", which
 * is unfixable at a distance for an app that runs on a machine we will never see, against a
 * folder layout we cannot reproduce, at the end of a raid night.
 *
 * Three deliberate choices:
 *
 * - The report is SHOWN before it is sent, verbatim. Being asked to send diagnostics you are
 *   not allowed to read is how a cautious person decides not to, and the people running this
 *   for a guild are disproportionately cautious.
 * - The note field comes first and is the only thing they have to write. A stack trace says
 *   where it broke; one sentence about what they were doing says why it matters.
 * - Copy and Open log folder stay, because sending needs a network and the problem might be
 *   the network.
 */
export function ReportProblem({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [note, setNote] = useState('');
  const [report, setReport] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [state, setState] = useState<SendState>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);

  async function load(): Promise<string> {
    if (report) return report;
    const loaded = await window.companion.diagnosticsReport();
    setReport(loaded.report);
    return loaded.report;
  }

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (next) await load();
  }

  async function send(): Promise<void> {
    setState({ kind: 'sending' });
    try {
      const result = await window.companion.sendDiagnostics(note);
      setState({ kind: 'sent', reportId: result.reportId });
    } catch (error) {
      setState({
        kind: 'failed',
        message: error instanceof Error ? error.message : 'Could not send the report.',
      });
    }
  }

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(await load());
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => void toggle()}
        className="self-start text-sm text-[var(--muted)] underline underline-offset-4 hover:text-[var(--foreground)]"
      >
        Something wrong? Send a report
      </button>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-[var(--border)] bg-[var(--card)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-medium">Send a report</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Sends the app&apos;s recent log to Raidify so we can see what actually happened. Your
            sign-in token and your Windows folder names are removed before it leaves.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          Close
        </button>
      </div>

      {state.kind === 'sent' ? (
        <p className="rounded border-l-4 border-[var(--success)] bg-[var(--background)] px-4 py-3 text-sm">
          Sent. Quote <code className="selectable">{state.reportId.slice(0, 8)}</code> if you follow
          it up in Discord.
        </p>
      ) : (
        <>
          <label className="flex flex-col gap-1.5 text-sm">
            <span>What were you doing when it went wrong?</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Pressed Send on Tuesday's raid and it said the request failed."
              className="resize-y rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
            />
            <span className="text-xs text-[var(--muted)]">
              Optional, and the most useful part. The log says where it broke; this says what you
              were trying to do.
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void send()}
              disabled={state.kind === 'sending'}
              className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] disabled:opacity-60"
            >
              {state.kind === 'sending' ? 'Sending…' : 'Send to Raidify'}
            </button>
            <button
              type="button"
              onClick={() => void copy()}
              className="rounded border border-[var(--border)] px-4 py-2 text-sm"
            >
              {copied ? 'Copied' : 'Copy instead'}
            </button>
            <button
              type="button"
              onClick={() => void window.companion.openLogFolder()}
              className="rounded border border-[var(--border)] px-4 py-2 text-sm"
            >
              Open log folder
            </button>
          </div>

          {state.kind === 'failed' && (
            <p className="rounded border-l-4 border-[var(--warning)] bg-[var(--background)] px-4 py-3 text-sm text-[var(--warning)]">
              {state.message} You can still press Copy and paste it to us in Discord.
            </p>
          )}
        </>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowDetail((value) => !value)}
          className="text-sm text-[var(--muted)] underline underline-offset-4 hover:text-[var(--foreground)]"
        >
          {showDetail ? 'Hide' : 'Show'} exactly what gets sent
        </button>
        {showDetail && (
          <pre className="selectable mt-2 max-h-72 overflow-auto rounded border border-[var(--border)] bg-[var(--background)] p-3 text-xs leading-relaxed">
            {report ?? 'Loading…'}
          </pre>
        )}
      </div>
    </section>
  );
}
