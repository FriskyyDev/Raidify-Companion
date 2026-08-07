import { useState } from 'react';
import type { PendingLootExport } from '../../shared/types';
import type { LootSessionImportResult } from '../../shared/contract';

/**
 * One exported loot night, waiting to be sent.
 *
 * Deliberately thinner than NightCard. An attendance night is a judgement the officer may
 * want to inspect row by row before it becomes a record; a loot session is a sealed string
 * the addon already produced. There is nothing here to adjudicate — the only real question
 * is "is this the night I meant", so the card answers that and gets out of the way.
 */
export function LootExportCard({
  night,
  disabled,
  onUpload,
}: {
  night: PendingLootExport;
  disabled: boolean;
  onUpload: (dryRun: boolean) => Promise<LootSessionImportResult>;
}) {
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null);
  const [result, setResult] = useState<LootSessionImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'preview' : 'send');
    setError(null);
    try {
      setResult(await onUpload(dryRun));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(null);
    }
  }

  const when = night.endedAt ?? night.startedAt ?? night.exportedAt;

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--card)] px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">
          {when ? when.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : 'Loot session'}
        </h3>
        <span className="text-sm text-[var(--muted)]">
          {night.awards === 1 ? '1 award' : `${night.awards} awards`}
        </span>
      </div>

      {when && (
        <p className="mt-1 text-sm text-[var(--muted)]">
          {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {night.exportedAt && ` · exported ${night.exportedAt.toLocaleDateString()}`}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border border-[var(--border)] px-3 py-1.5 text-sm"
          disabled={disabled || busy !== null}
          onClick={() => void run(true)}
        >
          {busy === 'preview' ? 'Checking…' : 'Check it first'}
        </button>
        <button
          type="button"
          className="rounded bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--background)] disabled:opacity-40"
          disabled={disabled || busy !== null}
          onClick={() => void run(false)}
        >
          {busy === 'send' ? 'Sending…' : 'Send to Raidify'}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-[var(--error)]">{error}</p>}

      {result && !error && (
        <div className="mt-3 text-sm text-[var(--muted)]">
          <p>
            {result.dryRun ? 'Would record' : 'Recorded'} {result.recorded} of{' '}
            {result.awardsParsed === 1 ? '1 award' : `${result.awardsParsed} awards`}
            {result.alreadyRecorded > 0 && `, ${result.alreadyRecorded} already on record`}.
          </p>

          {/* Names the server could not match are the one thing worth acting on: an award
              to somebody with no character on Raidify is silently not recorded otherwise. */}
          {result.unmatchedRecipients.length > 0 && (
            <p className="mt-1 text-[var(--warning)]">
              No character matched: {result.unmatchedRecipients.join(', ')}
            </p>
          )}
          {result.unmatchedItems.length > 0 && (
            <p className="mt-1 text-[var(--warning)]">
              No item matched: {result.unmatchedItems.join(', ')}
            </p>
          )}
          {result.warnings.map((w) => (
            <p key={w} className="mt-1 text-[var(--warning)]">
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
