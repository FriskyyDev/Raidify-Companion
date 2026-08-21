import type { SavedVariablesCandidate } from './types';

/**
 * Which install to start watching without being asked.
 *
 * Setup step 3 used to complete only when the officer clicked a row in the results list.
 * That list has no heading and no instruction — it renders directly under "Find it for me"
 * as a plain bordered button per install — so it reads as the *answer* ("we found your
 * folder") rather than as a *question* ("which of these?"). A v0.2.1 report said exactly
 * that: steps 1 and 2 ticked, step 3 not, "although I have pointed to the folder and the
 * program has recognized the correct folder". The scan worked; the click never happened.
 *
 * When there is one candidate there is nothing to choose between, so asking is ceremony
 * that can only be got wrong. Two or more is a real question and still gets asked.
 *
 * `current` is the path already being watched: a re-scan must never silently move the
 * officer onto a different account than the one they picked, so any existing choice wins.
 */
export function autoChosenInstall(
  candidates: SavedVariablesCandidate[],
  current: string | null,
): SavedVariablesCandidate | null {
  if (current) return null;
  return candidates.length === 1 ? candidates[0]! : null;
}
