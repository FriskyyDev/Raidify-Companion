import { useEffect, useState } from 'react';
import type { CompatVerdict } from '../shared/contract';
import { StatusBanner } from './components/StatusBanner';

interface AppInfo {
  version: string;
  canRememberSignIn: boolean;
  platform: string;
}

/**
 * The shell.
 *
 * v0's UI is a real deliverable rather than a tray menu, so the frame it will grow into
 * is here from the start: a status line the officer can read at a glance, and room below
 * it for setup and upload history. What is not here yet is marked as such — an empty
 * panel that pretends to work is worse than one that says what it is waiting for.
 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [compat, setCompat] = useState<CompatVerdict | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    void (async () => {
      setInfo(await window.companion.appInfo());
      setSignedIn((await window.companion.authStatus()).signedIn);
      setCompat(await window.companion.checkCompat());
    })();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Raidify Companion</h1>
          <p className="text-sm text-[var(--muted)]">
            Uploads your raid attendance so nobody has to paste it.
          </p>
        </div>
        <span className="selectable text-xs text-[var(--muted)]">
          {info ? `v${info.version}` : ''}
        </span>
      </header>

      <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
        <StatusBanner compat={compat} />

        <section className="rounded border border-[var(--border)] bg-[var(--card)] p-5">
          <h2 className="font-medium">Setup</h2>
          <ol className="mt-3 space-y-2 text-sm text-[var(--muted)]">
            <li>{signedIn ? '✓ Signed in' : '1 · Sign in to Raidify'}</li>
            <li>2 · Choose which guild this machine reports for</li>
            <li>3 · Point at your World of Warcraft folder</li>
          </ol>
          <p className="mt-4 text-xs text-[var(--muted)]">
            Not wired up yet — sign-in, guild picker and folder picker land next.
          </p>
          {info && !info.canRememberSignIn && (
            <p className="mt-2 text-xs text-[var(--warning)]">
              This system has no secure credential store, so a sign-in cannot be remembered
              between launches.
            </p>
          )}
        </section>

        <section className="rounded border border-[var(--border)] bg-[var(--card)] p-5">
          <h2 className="font-medium">Recent uploads</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Nothing yet. Finished raid nights will appear here with what was sent.
          </p>
        </section>
      </main>
    </div>
  );
}
