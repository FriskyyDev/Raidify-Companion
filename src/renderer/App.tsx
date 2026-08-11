import { useCallback, useEffect, useState } from 'react';
import type { CompanionGuild, CompatVerdict } from '../shared/contract';
import type {
  ParsedNight,
  PendingLootExport,
  SavedVariablesCandidate,
  Settings,
} from '../shared/types';
import { nightKey } from '../shared/nightKey';
import { LootExportCard } from './components/LootExportCard';
import { NightCard } from './components/NightCard';
import { SetupPanel } from './components/SetupPanel';
import { StatusBanner } from './components/StatusBanner';
import { ReportProblem } from './components/ReportProblem';
import mark from './assets/raidify-mark.png';

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
  const [searchOutcome, setSearchOutcome] = useState<
    'cancelled' | 'none' | 'not-detected' | 'found' | null
  >(null);
  const [searchedPath, setSearchedPath] = useState<string | null>(null);
  const [pendingLoot, setPendingLoot] = useState<PendingLootExport[]>([]);
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
        setPendingLoot(await window.companion.pendingLootExports());
      }
    })();
  }, [loadGuilds]);

  /*
   * Keep asking, while the answer is no.
   *
   * The compat check used to run exactly once, on mount. Anything other than "ok" then blocked
   * every upload for the life of the window — and this app is built to stay open for weeks, so
   * one cold start, one VPN handshake or one 502 disabled sending until somebody thought to
   * quit and relaunch. The banner meanwhile said "Nights are kept until it comes back", which
   * described a recovery that could not happen.
   *
   * Only while unhealthy: a working install must not poll a server it has no question for.
   * Also on focus, because alt-tabbing back is exactly when somebody is wondering why it is
   * still complaining.
   */
  const compatUnhealthy = compat !== null && compat.kind !== 'ok';
  useEffect(() => {
    if (!compatUnhealthy) return;

    const recheck = () => void window.companion.checkCompat().then(setCompat);
    const timer = setInterval(recheck, 60_000);
    window.addEventListener('focus', recheck);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', recheck);
    };
  }, [compatUnhealthy]);

  // Subscribed once, for the life of the window. A flush landing while the officer reads
  // is the normal case — they alt-tab out of the game and the file arrives.
  useEffect(() => {
    // Both saved-variables files are flushed by the same logout, so the core file's
    // event is a reliable moment to re-read the loot one too. No second watcher needed.
    const refreshLoot = () => void window.companion.pendingLootExports().then(setPendingLoot);

    const stopNights = window.companion.onNights((incoming) => {
      setNights(incoming);
      setLastEmptyRead(null);
      setWatchError(null);
      refreshLoot();
    });
    const stopEmpty = window.companion.onEmptyRead((info) => {
      // A later read finding nothing means the file was rewritten without a session in
      // it, so the nights we were showing are gone too. Saying so beats leaving stale
      // cards on screen that no longer exist on disk.
      setNights([]);
      setLastEmptyRead(info.at);
      setWatchError(null);
      // A loot-only night reads as empty here — there may still be loot to send.
      refreshLoot();
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

  const uploadsBlocked = compatUnhealthy;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-6 py-3">
        {/*
          The same lockup the web app puts in its sidebar: the mark at 32px, then the name
          in Inter semibold with tight tracking. Matched deliberately rather than
          approximated — two products showing two different wordmarks on one desktop is
          exactly the drift this pass exists to remove.

          "Companion" is the structural label rather than part of the name, which is what
          `label-structural` is for and what the web app does with its own qualifiers.

          The tagline that used to sit here is gone. It explained the app on every single
          launch, and this app is designed to stay open for weeks — a sentence you have
          read four hundred times is furniture. The setup panel introduces the app once,
          to the only person who has not met it.
        */}
        <div className="flex items-center gap-2.5">
          <img src={mark} alt="" className="h-8 w-8" />
          <div className="flex flex-col leading-none">
            <span className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
              Raidify
            </span>
            <span className="label-structural mt-0.5 text-[var(--text-quaternary)]">
              Companion
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/*
            The connection state, at the weight it deserves.

            This replaced a full-width green card that said "Connected" on every launch.
            Healthy is the normal case and does not need a paragraph; it needs to be
            checkable at a glance and otherwise stay out of the way. Anything actually
            wrong still gets the banner below.
          */}
          {compat?.kind === 'ok' && (
            <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--success)' }}
              />
              Connected
            </span>
          )}
          <span className="selectable text-xs text-[var(--muted)]">
            {info ? `v${info.version}` : ''}
          </span>
        </div>
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
              // Dark text on Signal. Was a hardcoded #14161c, which stopped matching
              // anything the moment the surfaces moved to hue 220.
              style={{ background: 'var(--accent)', color: 'var(--bg-canvas)' }}
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
          searchedPath={searchedPath}
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
          onDetect={async () => {
            const found = await window.companion.detectInstalls();
            setInstalls(found);
            // Previously set only `installs`. An empty scan therefore rendered nothing at
            // all: no list, and no outcome for the panel to report — so "Find it for me"
            // looked like a dead button.
            setSearchedPath(null);
            setSearchOutcome(found.length > 0 ? 'found' : 'not-detected');
          }}
          onBrowse={async () => {
            const result = await window.companion.browseForInstall();
            setSearchOutcome(result.outcome);
            setSearchedPath(result.outcome === 'none' ? result.searchedPath : null);
            // A cancel leaves whatever was already on screen alone — the officer did not
            // ask us to forget the installs we had found.
            if (result.outcome === 'found') setInstalls(result.candidates);
            else if (result.outcome === 'none') setInstalls([]);
          }}
          onChooseInstall={async (candidate) => {
            setSettings(
              await window.companion.saveSettings({
                savedVariablesPath: candidate.path,
                // The loot file is derived in the main process from this install, not sent
                // from here — it is a property of what discovery found, not a choice.
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

        {/*
          Only for guilds that actually run loot council. A guild with no loot addon has
          no pending exports and never sees this heading — the section is absent rather
          than empty, because an empty box for a feature you do not use is clutter.
        */}
        {pendingLoot.length > 0 && (
          <section className="flex flex-col gap-3">
            <h2 className="font-medium">Loot sessions</h2>
            {pendingLoot.map((night) => (
              <LootExportCard
                key={night.nightId ?? night.payload.slice(0, 32)}
                night={night}
                disabled={!signedIn || !settings?.guildId}
                onUpload={async (dryRun) => {
                  const result = await window.companion.uploadLootSession(
                    night.payload,
                    night.nightId,
                    dryRun,
                  );
                  // A real send takes the night off the list. Re-read rather than filter
                  // locally, so what is on screen matches what the main process recorded.
                  if (!dryRun) setPendingLoot(await window.companion.pendingLootExports());
                  return result;
                }}
              />
            ))}
          </section>
        )}

        {/*
          Always present, at the bottom, quiet until it is needed — and already open when
          something has visibly gone wrong, because that is the moment somebody would look for
          it and the moment they are least inclined to hunt.
        */}
        <ReportProblem defaultOpen={!!watchError} />
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
