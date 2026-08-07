import type { CompatVerdict } from '../../shared/contract';

/**
 * Says something only when something is wrong.
 *
 * The companion's whole promise is that an officer stops thinking about attendance. That
 * only holds if, on the rare occasion it is not working, the app says so plainly instead
 * of looking idle — a silent failure is the reason the browser route was abandoned.
 *
 * Which is exactly why the healthy case renders NOTHING. It used to get a full two-line
 * green card reading "Connected — Raidify is reachable and accepting uploads", at the top
 * of the window, every single launch. A banner that is present when everything is fine is
 * furniture, and the reader learns to skip the place the real warnings appear. The
 * connection state still shows, quietly, in the header.
 */
export function StatusBanner({ compat }: { compat: CompatVerdict | null }) {
  // Nothing while the first check is in flight either — a "Checking…" card that lives for
  // 200ms is a flash of furniture rather than information.
  if (!compat) return null;

  switch (compat.kind) {
    case 'ok':
      return compat.updateAvailable ? (
        <Banner
          tone="warning"
          title="An update is available"
          body="This version still works. Updating gets you the latest fixes."
        />
      ) : null;

    case 'update-required':
      return (
        <Banner
          tone="error"
          title="This version is too old to upload"
          body={
            compat.downloadUrl
              ? 'Update to keep recording attendance automatically.'
              : 'Update to keep recording attendance automatically. Ask in Discord for the latest build.'
          }
        />
      );

    case 'uploads-paused':
      return (
        <Banner
          tone="warning"
          title="Uploads are paused"
          body={compat.notice ?? 'Raidify has paused companion uploads. Pasting still works.'}
        />
      );

    case 'payload-mismatch':
      return (
        <Banner
          tone="error"
          title="This version speaks a different format"
          body={`Raidify expects format ${compat.got}, this build sends ${compat.expected}. Uploading is disabled rather than risk sending a night that gets misread.`}
        />
      );

    case 'unreachable':
      return (
        <Banner
          tone="warning"
          title="Can't reach Raidify"
          body="Nights are kept until it comes back. Nothing is lost; nothing is uploaded yet."
        />
      );
  }
}

const TONES = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  error: 'var(--error)',
  muted: 'var(--muted)',
} as const;

function Banner({
  tone,
  title,
  body,
}: {
  tone: keyof typeof TONES;
  title: string;
  body: string;
}) {
  return (
    <div
      className="rounded border-l-4 bg-[var(--card)] px-5 py-4"
      style={{ borderLeftColor: TONES[tone] }}
    >
      <p className="font-medium" style={{ color: TONES[tone] }}>
        {title}
      </p>
      <p className="mt-1 text-sm text-[var(--muted)]">{body}</p>
    </div>
  );
}
