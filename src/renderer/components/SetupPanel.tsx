import { useState } from 'react';
import type { CompanionGuild } from '../../shared/contract';
import type { SavedVariablesCandidate, Settings } from '../../shared/types';

/**
 * The three questions, asked once.
 *
 * Who are you, which guild does this machine report for, and where is the game. Nothing
 * else — every extra question here is a reason to close the app and go back to pasting a
 * string, which already works.
 *
 * Collapses to a single line once answered, because setup is not what the officer opens
 * this app to look at.
 */
export function SetupPanel({
  settings,
  signedIn,
  canRememberSignIn,
  signInMemoryBlocker,
  guilds,
  guildsFailed,
  onRetryGuilds,
  installs,
  searchOutcome,
  watchingPath,
  onSignIn,
  onSignOut,
  onChooseGuild,
  onDetect,
  onBrowse,
  onChooseInstall,
}: {
  settings: Settings | null;
  signedIn: boolean;
  canRememberSignIn: boolean;
  signInMemoryBlocker: string | null;
  guilds: CompanionGuild[] | null;
  /** The list could not be fetched — not the same as the officer having no guilds. */
  guildsFailed: boolean;
  onRetryGuilds: () => Promise<void>;
  installs: SavedVariablesCandidate[] | null;
  /** How the last search ended, so a cancel is not reported as a missing file. */
  searchOutcome: 'cancelled' | 'none' | 'found' | null;
  watchingPath: string | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onChooseGuild: (guild: CompanionGuild) => Promise<void>;
  onDetect: () => Promise<void>;
  onBrowse: () => Promise<void>;
  onChooseInstall: (candidate: SavedVariablesCandidate) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guildChosen = Boolean(settings?.guildId);
  const fileChosen = Boolean(watchingPath);
  const done = signedIn && guildChosen && fileChosen;

  const [expanded, setExpanded] = useState(false);

  async function attempt(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  // Answered and working: one line, and a way back in. Anything more is a permanent
  // reminder of a job that is finished.
  if (done && !expanded) {
    return (
      <section className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--card)] px-5 py-3 text-sm">
        <p className="selectable text-[var(--muted)]">
          Watching for <span className="text-[var(--foreground)]">{settings?.guildName}</span> ·{' '}
          {shortPath(watchingPath)}
        </p>
        <button
          type="button"
          className="text-[var(--muted)] underline hover:text-[var(--foreground)]"
          onClick={() => setExpanded(true)}
        >
          Change
        </button>
      </section>
    );
  }

  return (
    <section className="rounded border border-[var(--border)] bg-[var(--card)] p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Setup</h2>
        {done && (
          <button
            type="button"
            className="text-sm text-[var(--muted)] underline hover:text-[var(--foreground)]"
            onClick={() => setExpanded(false)}
          >
            Done
          </button>
        )}
      </div>

      <ol className="mt-4 space-y-5">
        <Step index={1} title="Sign in to Raidify" complete={signedIn}>
          {signedIn ? (
            <button
              type="button"
              className="text-sm text-[var(--muted)] underline hover:text-[var(--foreground)]"
              disabled={busy !== null}
              onClick={() => void attempt('signout', onSignOut)}
            >
              Sign out
            </button>
          ) : (
            <>
              <Action
                label="Sign in"
                busy={busy === 'signin'}
                disabled={busy !== null}
                onClick={() => void attempt('signin', onSignIn)}
              />
              <p className="mt-2 text-xs text-[var(--muted)]">
                Opens your browser. If you are already signed in to Raidify there, it is one
                click and nothing to type.
              </p>
              {!canRememberSignIn && (
                <p className="mt-2 text-xs text-[var(--warning)]">
                  {signInMemoryBlocker ??
                    'This system has no secure credential store, so the sign-in cannot be remembered between launches.'}
                </p>
              )}
            </>
          )}
        </Step>

        <Step index={2} title="Choose the guild this machine reports for" complete={guildChosen}>
          {!signedIn ? (
            <p className="text-sm text-[var(--muted)]">Sign in first.</p>
          ) : guildsFailed ? (
            // Distinct from an empty list on purpose. This is almost always a network
            // blip or an expired sign-in, and reporting it as a permissions problem sent
            // officers to a settings page to look for something that was never wrong.
            <div className="space-y-2">
              <p className="text-sm text-[var(--warning)]">
                Couldn't reach Raidify to load your guilds. That is usually the connection
                rather than anything about your account.
              </p>
              <Action
                label="Try again"
                busy={busy === 'guilds'}
                disabled={busy !== null}
                onClick={() => void attempt('guilds', onRetryGuilds)}
                quiet
              />
            </div>
          ) : guilds === null ? (
            <p className="text-sm text-[var(--muted)]">Loading your guilds…</p>
          ) : guilds.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              None of your guilds let you manage raids, so there is nothing this machine can
              report for. An officer can grant that on the guild's settings page.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {guilds.map((guild) => (
                <button
                  key={guild.id}
                  type="button"
                  className="rounded border px-3 py-1.5 text-sm"
                  style={{
                    borderColor:
                      settings?.guildId === guild.id ? 'var(--primary)' : 'var(--border)',
                    color: settings?.guildId === guild.id ? 'var(--primary)' : undefined,
                  }}
                  disabled={busy !== null}
                  onClick={() => void attempt('guild', () => onChooseGuild(guild))}
                >
                  {guild.name}
                </button>
              ))}
            </div>
          )}
        </Step>

        <Step index={3} title="Point at your World of Warcraft folder" complete={fileChosen}>
          <div className="flex flex-wrap gap-2">
            <Action
              label="Find it for me"
              busy={busy === 'detect'}
              disabled={busy !== null}
              onClick={() => void attempt('detect', onDetect)}
            />
            <Action
              label="Choose the folder"
              busy={busy === 'browse'}
              disabled={busy !== null}
              onClick={() => void attempt('browse', onBrowse)}
              quiet
            />
          </div>

          {/* Only when a search actually came back empty. Pressing Cancel on the folder
              picker used to land here too, so changing your mind about a dialog was
              reported as your addon never having run. */}
          {searchOutcome === 'none' && (
            <p className="mt-3 text-sm text-[var(--warning)]">
              No Raidify saved-variables file in that folder. Either it is not your World of
              Warcraft folder, or the addon has not written yet — that file only appears
              after the addon has run at least once and you have logged out or typed{' '}
              <code className="selectable">/reload</code>, because the game keeps it in
              memory until then.
            </p>
          )}

          {installs !== null && installs.length > 0 && (
            <ul className="mt-3 space-y-2">
              {installs.map((candidate) => (
                <li key={candidate.path}>
                  <button
                    type="button"
                    className="w-full rounded border px-3 py-2 text-left text-sm"
                    style={{
                      borderColor:
                        watchingPath === candidate.path ? 'var(--primary)' : 'var(--border)',
                    }}
                    disabled={busy !== null}
                    onClick={() => void attempt('choose', () => onChooseInstall(candidate))}
                  >
                    <span className="block">
                      {candidate.flavour} · {candidate.account}
                    </span>
                    <span className="selectable block text-xs text-[var(--muted)]">
                      Last written {new Date(candidate.modifiedAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Step>
      </ol>

      {error && <p className="mt-4 text-sm text-[var(--error)]">{error}</p>}
    </section>
  );
}

function Step({
  index,
  title,
  complete,
  children,
}: {
  index: number;
  title: string;
  complete: boolean;
  children: React.ReactNode;
}) {
  return (
    <li>
      <p className="flex items-center gap-2 text-sm font-medium">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs"
          style={{
            borderColor: complete ? 'var(--success)' : 'var(--border)',
            color: complete ? 'var(--success)' : 'var(--muted)',
          }}
        >
          {complete ? '✓' : index}
        </span>
        {title}
      </p>
      <div className="mt-2 pl-7">{children}</div>
    </li>
  );
}

function Action({
  label,
  busy,
  disabled,
  onClick,
  quiet,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        quiet
          ? 'rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:border-[var(--primary)] disabled:opacity-50'
          : 'rounded bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--background)] disabled:opacity-40'
      }
      disabled={disabled}
      onClick={onClick}
    >
      {busy ? 'Working…' : label}
    </button>
  );
}

/** The middle of a saved-variables path is folder names nobody reads. */
function shortPath(path: string | null): string {
  if (!path) return '';
  const parts = path.split(/[\\/]/);
  return parts.slice(-4).join('/');
}
