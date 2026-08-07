import { useState } from 'react';
import type { PendingLootExport } from '../../shared/types';
import type { LootSessionImportResult } from '../../shared/contract';

/**
 * One exported loot night, waiting to be sent.
 *
 * Thinner than NightCard, because the payload is a sealed string the addon already
 * produced — there are no buckets to argue with here. But it is checked before it is sent,
 * exactly as attendance is: the server still has to match every recipient to a character
 * and every item to the catalog, and an award to a name it cannot place is silently not
 * recorded. That is worth seeing before it becomes the guild's permanent record, not after.
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
  /** The last dry run. Sending is gated on having one — see the action row below. */
  const [preview, setPreview] = useState<LootSessionImportResult | null>(null);
  const [sent, setSent] = useState<LootSessionImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'preview' : 'send');
    setError(null);
    try {
      const outcome = await onUpload(dryRun);
      if (dryRun) setPreview(outcome);
      else setSent(outcome);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(null);
    }
  }

  const result = sent ?? preview;
  /** Things the officer can actually go and fix before committing this to the record. */
  const fixable =
    (preview?.unmatchedRecipients.length ?? 0) + (preview?.unmatchedItems.length ?? 0) > 0;

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

          {/*
            Somewhere to go about it.

            Every remedy lives on the website — linking a character, adding a pug as an
            external raider. Naming the problem and stopping there leaves the officer to
            hunt for the right page mid-raid, which is how a warning turns into a shrug.
            The check can be re-run afterwards without re-reading the file.
          */}
          {fixable && !sent && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--foreground)] hover:border-[var(--primary)]"
                onClick={() => void window.companion.openInRaidify('loot-raiders')}
              >
                Fix on the website
              </button>
              <span className="text-xs">Then check again — nothing has been sent yet.</span>
            </div>
          )}
        </div>
      )}

      {!sent && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="rounded border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--primary)] disabled:opacity-50"
            disabled={disabled || busy !== null}
            onClick={() => void run(true)}
          >
            {busy === 'preview' ? 'Checking…' : preview ? 'Check again' : 'Review'}
          </button>

          {/*
            Gated on a review, exactly as attendance is.

            Both write a permanent record a guild will argue from later, and the preview
            runs the identical server path with the write turned off — so seeing it is not
            a promise about the send, it is the send with nothing committed. Letting loot
            go straight out while attendance had to be checked was two safety models for
            one act.
          */}
          <button
            type="button"
            className="rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--background)] disabled:opacity-40"
            disabled={disabled || busy !== null || preview === null}
            onClick={() => void run(false)}
          >
            {busy === 'send' ? 'Sending…' : 'Send to Raidify'}
          </button>

          {preview === null && busy === null && (
            <span className="text-sm text-[var(--muted)]">Review it first.</span>
          )}
        </div>
      )}
    </div>
  );
}
