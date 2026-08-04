import { useState } from 'react';
import { AttendanceBucket, type AttendanceUploadResult } from '../../shared/contract';
import type { ParsedNight, UploadedNight } from '../../shared/types';

/**
 * One raid night, and the decision to send it.
 *
 * Never sends on its own. The officer is the one who knows whether Tuesday's session on
 * an alt was the guild's Naxx run or three people messing about in Deadmines, and this
 * app has no way to tell those apart — so it reports what it read and waits.
 *
 * "Review" runs a dry run against the real server path, so what is shown is what will
 * happen rather than a second guess at it.
 */
export function NightCard({
  night,
  alreadySent,
  onUpload,
}: {
  night: ParsedNight;
  alreadySent: UploadedNight | undefined;
  onUpload: (night: ParsedNight, dryRun: boolean) => Promise<AttendanceUploadResult>;
}) {
  const [preview, setPreview] = useState<AttendanceUploadResult | null>(null);
  const [sent, setSent] = useState<AttendanceUploadResult | null>(null);
  const [busy, setBusy] = useState<'review' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = summarise(night);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? 'review' : 'send');
    setError(null);
    try {
      const result = await onUpload(night, dryRun);
      if (dryRun) setPreview(result);
      else setSent(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="rounded border border-[var(--border)] bg-[var(--card)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="selectable font-medium">
            {night.raidTitle ?? 'Raid night'}{' '}
            <span className="text-[var(--muted)]">· {night.characterKey}</span>
          </h3>
          <p className="selectable mt-1 text-sm text-[var(--muted)]">
            {describeWhen(night)} · {counts.total} raiders
          </p>
        </div>

        <div className="flex items-center gap-2">
          {night.stale && <Tag tone="warning">Old night</Tag>}
          {!night.finished && <Tag tone="warning">Still running</Tag>}
          {alreadySent && <Tag tone="muted">Sent</Tag>}
        </div>
      </div>

      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <Count label="Turned up" value={counts.attended} />
        <Count label="Benched" value={counts.benched} />
        {/* Named plainly. These are people nobody accounted for, and calling them absent
            here is exactly the accusation the addon refuses to make. */}
        <Count label="Nobody said" value={counts.unresolved} muted />
      </ul>

      {night.stale && (
        <Note tone="warning">
          This night is more than two weeks old. Sending it now rewrites the record for that
          date — fine if you meant to, worth a second look if you did not.
        </Note>
      )}

      {!night.finished && (
        <Note tone="warning">
          The addon has not ended this session. Send it and anyone who joins later will be
          missing. Type <code className="selectable">/rf end</code> in game first if the raid
          is over.
        </Note>
      )}

      {alreadySent && !sent && (
        <Note tone="muted">
          Sent {relative(alreadySent.uploadedAt)}. Sending again corrects the record rather
          than duplicating it.
        </Note>
      )}

      {error && <Note tone="error">{error}</Note>}

      {sent ? (
        <Note tone="success">
          {describeResult(sent)}
          {sent.unmatchedRaiders.length > 0 && (
            <UnmatchedList names={sent.unmatchedRaiders} />
          )}
        </Note>
      ) : (
        <>
          {preview && (
            <Note tone="muted">
              {describeResult(preview, true)}
              {preview.warnings.map((w) => (
                <span key={w} className="mt-1 block text-[var(--warning)]">
                  {w}
                </span>
              ))}
              {preview.unmatchedRaiders.length > 0 && (
                <UnmatchedList names={preview.unmatchedRaiders} />
              )}
            </Note>
          )}

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              className="rounded border border-[var(--border)] px-4 py-2 text-sm hover:border-[var(--primary)] disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void run(true)}
            >
              {busy === 'review' ? 'Checking…' : preview ? 'Check again' : 'Review'}
            </button>

            {/* Deliberately gated on a review. The officer sees what a send does before
                one happens — and because the preview runs the same server path, seeing it
                is not a promise about the send, it is the send with the write turned off. */}
            <button
              type="button"
              className="rounded bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--background)] disabled:opacity-40"
              disabled={busy !== null || preview === null}
              onClick={() => void run(false)}
              title={preview === null ? 'Review it first' : undefined}
            >
              {busy === 'send' ? 'Sending…' : 'Send to Raidify'}
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function UnmatchedList({ names }: { names: string[] }) {
  return (
    <span className="selectable mt-2 block text-[var(--muted)]">
      No Raidify account matched: {names.join(', ')}. They are not counted either way —
      linking their character on the website fixes it for next time.
    </span>
  );
}

function describeResult(result: AttendanceUploadResult, preview = false): string {
  const verb = preview ? 'would be' : 'were';
  const parts: string[] = [];
  if (result.recorded) parts.push(`${result.recorded} ${verb} recorded`);
  if (result.updated) parts.push(`${result.updated} ${verb} corrected`);
  if (result.unchanged) parts.push(`${result.unchanged} already matched`);

  const where = result.raidTitle
    ? `“${result.raidTitle}”`
    : 'a night not on the schedule, which will be recorded on its own';

  return parts.length === 0
    ? `Nothing to change against ${where}.`
    : `${parts.join(', ')} against ${where}.`;
}

interface Counts {
  total: number;
  attended: number;
  benched: number;
  unresolved: number;
}

function summarise(night: ParsedNight): Counts {
  const counts: Counts = { total: night.rows.length, attended: 0, benched: 0, unresolved: 0 };

  for (const row of night.rows) {
    switch (row.bucket) {
      case AttendanceBucket.Present:
      case AttendanceBucket.Late:
      case AttendanceBucket.LeftEarly:
        counts.attended++;
        break;
      case AttendanceBucket.Benched:
        counts.benched++;
        break;
      default:
        counts.unresolved++;
    }
  }

  return counts;
}

function describeWhen(night: ParsedNight): string {
  if (!night.startedAt) return 'Time unknown';

  const started = new Date(night.startedAt);
  const date = started.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const from = started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!night.endedAt) return `${date}, from ${from}`;

  const ended = new Date(night.endedAt);
  const to = ended.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${from}–${to}`;
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function Count({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  if (value === 0) return null;
  return (
    <li className={muted ? 'text-[var(--muted)]' : undefined}>
      <span className="font-medium">{value}</span> {label}
    </li>
  );
}

const TONES = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  error: 'var(--error)',
  muted: 'var(--muted)',
} as const;

function Note({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <p
      className="mt-3 border-l-2 pl-3 text-sm"
      style={{ borderLeftColor: TONES[tone], color: TONES[tone] }}
    >
      {children}
    </p>
  );
}

function Tag({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <span
      className="rounded border px-2 py-0.5 text-xs"
      style={{ borderColor: TONES[tone], color: TONES[tone] }}
    >
      {children}
    </span>
  );
}
