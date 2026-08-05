import { useCallback, useEffect, useState } from 'react';
import type { CompanionGuild, CompatVerdict } from '../shared/contract';
import type { ParsedNight, SavedVariablesCandidate, Settings } from '../shared/types';
import { nightKey } from '../shared/nightKey';
import { NightCard } from './components/NightCard';
import { SetupPanel } from './components/SetupPanel';
import { StatusBanner } from './components/StatusBanner';

interface AppInfo {
  version: string;
  canRememberSignIn: boolean;
  signInMemoryBlocker: string | null;
  platform: string;
}

/**
 * The shell.
 *
 * Answer three setup questions once, then this window has one job: show the raid nights
 * sitting in the saved-variables file and let the officer send one. It never sends on its
 * own — see NightCard for why.
 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [compat, setCompat] = useState<CompatVerdict | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [guilds, setGuilds] = useState<CompanionGuild[] | null>(null);
  /** The guild list could not be fetched — as opposed to being genuinely empty. */
  const [guildsFailed, setGuildsFailed] = useState(false);
  const [installs, setInstalls] = useState<SavedVariablesCandidate[] | null>(null);
  /** How the last folder search ended, so the UI can tell a cancel from an empty result. */
  const [searchOutcome, setSearchOutcome] = useState<'cancelled' | 'none' | 'found' | null>(null);
  const [watchingPath, setWatchingPath] = useState<string | null>(null);
  const [nights, setNights] = useState<ParsedNight[]>([]);
  const [watchError, setWatchError] = useState<string | null>(null);
  /** When the file was last read and found to hold no raid session. */
  const [lastEmptyRead, setLastEmptyRead] = useState<string | null>(null);
  /** A downloaded update waiting for the officer to choose a moment to restart. */
  const [updateReady, setUpdateReady] = useState<{ version: string } | null>(null);

  // The guild list needs a working sign-in, and sign-in state changes at runtime. Keeping
  // the fetch in one place stops it being fired twice by two callers that both mean "we
  // are signed in now".
  const loadGuilds = useCallback(async () => {
    try {
      setGuilds(await window.companion.listGuilds());
      setGuildsFailed(false);
    } catch {
      // An empty list and a failed request are different facts, and collapsing them here
      // meant a network blip rendered as "none of your guilds let you manage raids" —
      // a permissions verdict, delivered to an officer, pointing them at a settings page
      // where they would find nothing wrong. Kept separate so the panel can say which
      // one actually happened.
      setGuilds(null);
      setGuildsFailed(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setInfo(await window.companion.appInfo());
      setSettings(await window.companion.getSettings());

      const auth = await window.companion.authStatus();
      setSignedIn(auth.signedIn);

      setCompat(await window.companion.checkCompat());

      if (auth.signedIn) {
        void loadGuilds();
        // Pick the file back up from last launch, and watch it again if that is what the
        // officer asked for.
        setWatchingPath((await window.companion.resume()).path);
      }
    })();
  }, [loadGuilds]);

  // Subscribed once, for the life of the window. A flush landing while the officer reads
  // is the normal case — they alt-tab out of the game and the file arrives.
  useEffect(() => {
    const stopNights = window.companion.onNights((incoming) => {
      setNights(incoming);
      setLastEmptyRead(null);
      setWatchError(null);
    });
    const stopEmpty = window.companion.onEmptyRead((info) => {
      // A later read finding nothing means the file was rewritten without a session in
      // it, so the nights we were showing are gone too. Saying so beats leaving stale
      // cards on screen that no longer exist on disk.
      setNights([]);
      setLastEmptyRead(info.at);
      setWatchError(null);
    });
    const stopErrors = window.companion.onWatchError((error) => setWatchError(error.message));
    const stopUpdate = window.companion.onUpdateReady(setUpdateReady);
    // An update can finish downloading before this window mounts.
    void window.companion.updateStatus().then(setUpdateReady);
    return () => {
      stopNights();
      stopEmpty();
      stopErrors();
      stopUpdate();
    };
  }, []);

  const sent = new Map((settings?.uploaded ?? []).map((u) => [u.key, u]));

  // Newest first: the night just finished is the one the officer opened the app for.
  const ordered = [...nights].sort((a, b) => time(b.startedAt) - time(a.startedAt));

  const uploadsBlocked = compat !== null && compat.kind !== 'ok';

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

        {updateReady && (
          // Offered, never forced. The officer picks the moment — an app that restarts
          // itself at 20:15 on a Tuesday is an app that gets closed before raid.
          <div className="flex flex-wrap items-center justify-between gap-3 rounded border-l-4 border-[var(--accent)] bg-[var(--card)] px-5 py-4">
            <div>
              <p className="font-medium">Update ready</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Version {updateReady.version} is downloaded. Restarting takes a few seconds
                and picks your file back up where it left off.
              </p>
            </div>
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm font-medium"
              style={{ background: 'var(--accent)', color: '#14161c' }}
              onClick={() => void window.companion.installUpdate()}
            >
              Restart now
            </button>
          </div>
        )}

        <SetupPanel
          settings={settings}
          signedIn={signedIn}
          canRememberSignIn={info?.canRememberSignIn ?? true}
          signInMemoryBlocker={info?.signInMemoryBlocker ?? null}
          guilds={guilds}
          guildsFailed={guildsFailed}
          onRetryGuilds={loadGuilds}
          installs={installs}
          searchOutcome={searchOutcome}
          watchingPath={watchingPath}
          onSignIn={async () => {
            await window.companion.signIn();
            setSignedIn(true);
            await loadGuilds();
          }}
          onSignOut={async () => {
            await window.companion.signOut();
            setSignedIn(false);
            setGuilds(null);
          }}
          onChooseGuild={async (guild) => {
            setSettings(
              await window.companion.saveSettings({ guildId: guild.id, guildName: guild.name }),
            );
          }}
          onDetect={async () => setInstalls(await window.companion.detectInstalls())}
          onBrowse={async () => {
            const result = await window.companion.browseForInstall();
            setSearchOutcome(result.outcome);
            // A cancel leaves whatever was already on screen alone — the officer did not
            // ask us to forget the installs we had found.
            if (result.outcome === 'found') setInstalls(result.candidates);
            else if (result.outcome === 'none') setInstalls([]);
          }}
          onChooseInstall={async (candidate) => {
            setSettings(
              await window.companion.saveSettings({
                savedVariablesPath: candidate.path,
                installPath: candidate.installPath,
              }),
            );
            setWatchingPath((await window.companion.watch(candidate.path)).path);
          }}
        />

        {watchError && (
          <p className="rounded border-l-4 border-[var(--warning)] bg-[var(--card)] px-5 py-4 text-sm text-[var(--warning)]">
            Could not read the saved-variables file: {watchError}
          </p>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="font-medium">Raid nights</h2>

          {!watchingPath ? (
            <Empty>Finish setup and your raid nights will appear here.</Empty>
          ) : ordered.length === 0 ? (
            <Empty>
              {lastEmptyRead ? (
                <>
                  Read your saved-variables file at{' '}
                  {new Date(lastEmptyRead).toLocaleTimeString()} and found no raid session in
                  it. Start one in game with <code className="selectable">/rf start</code>, and
                  it will appear here after you log out or type{' '}
                  <code className="selectable">/reload</code>.
                </>
              ) : (
                <>
                  Nothing yet. A raid night shows up here once you have logged out or typed{' '}
                  <code className="selectable">/reload</code> — the game holds the file in
                  memory until then, so it is not missing, just not written yet.
                </>
              )}
            </Empty>
          ) : uploadsBlocked ? (
            <Empty>
              {ordered.length} night{ordered.length === 1 ? '' : 's'} ready, held until Raidify
              is accepting uploads again. Nothing is lost.
            </Empty>
          ) : (
            ordered.map((night) => {
              const key = nightKey(night.characterKey, night.startedAt);
              return (
                <NightCard
                  key={key}
                  night={night}
                  alreadySent={sent.get(key)}
                  onUpload={async (target, dryRun) => {
                    const result = await window.companion.upload(target, dryRun);
                    // The main process is what recorded the send; re-read rather than guess
                    // at what it wrote, so the "Sent" mark and the file cannot disagree.
                    if (!dryRun) setSettings(await window.companion.getSettings());
                    return result;
                  }}
                />
              );
            })
          )}
        </section>
      </main>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-dashed border-[var(--border)] px-5 py-6 text-sm text-[var(--muted)]">
      {children}
    </p>
  );
}

function time(value: Date | string | null): number {
  if (!value) return 0;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}
