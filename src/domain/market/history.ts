/**
 * Deciding when daily history needs downloading.
 *
 * Market price points come in two kinds:
 *  - final closes (from daily history, or a quote taken after 16:15 ET), and
 *  - intraday points (`intraday: true`): today's live price, overwritten by
 *    each refresh and later replaced by the final close.
 *
 * Only FINAL closes count when looking for gaps, so a live price saved before
 * the app was closed for the day is corrected by the next history top-up.
 *
 *   no final closes yet          → download full history (1 credit)
 *   last final < latest complete → download since the day after it (1 credit)
 *   otherwise                    → nothing to do
 */

import { addDays, type IsoDate } from '../calendar/dates';
import type { PricePoint } from '../types';

export type HistoryRequest = { kind: 'full' } | { kind: 'since'; startDate: IsoDate } | null;

export function lastFinalClose(points: readonly PricePoint[]): IsoDate | undefined {
  let last: IsoDate | undefined;
  for (const p of points) if (p.source === 'market' && !p.intraday && (!last || p.date > last)) last = p.date;
  return last;
}

export function historyRequest(points: readonly PricePoint[], latestCompleted: IsoDate): HistoryRequest {
  const last = lastFinalClose(points);
  if (!last) return { kind: 'full' };
  if (last >= latestCompleted) return null;
  return { kind: 'since', startDate: addDays(last, 1) };
}
