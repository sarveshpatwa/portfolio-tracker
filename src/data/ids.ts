/** Random unique ids (crypto.randomUUID is available in all browsers that support PWAs). */
export function newId(): string {
  return crypto.randomUUID();
}

let lastSeq = 0;

/**
 * Monotonic sequence for ordering same-day ledger entries. Based on the clock
 * (microsecond-ish resolution) so it keeps increasing across app restarts
 * without storing a counter.
 */
export function nextSeq(): number {
  lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
  return lastSeq;
}
