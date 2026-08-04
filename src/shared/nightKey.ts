/**
 * Identify a night without waiting for the server to name it.
 *
 * The upload result carries the server's own `eventKey`, but that only exists after a
 * successful send and says nothing about the local session that produced it. This is
 * computed from what is in the saved-variables file, so a night can be recognised — and
 * matched against what has already been sent — before it is ever uploaded.
 *
 * Lives in `shared` because both sides need the same answer: the main process writes the
 * key into the upload history, and the renderer looks nights up by it. Two
 * implementations that drift by a millisecond would quietly re-offer every sent night.
 */
export function nightKey(characterKey: string, startedAt: Date | string | null): string {
  const at =
    startedAt === null
      ? 'unknown'
      : startedAt instanceof Date
        ? startedAt.toISOString()
        : new Date(startedAt).toISOString();
  return `${characterKey}|${at}`;
}
