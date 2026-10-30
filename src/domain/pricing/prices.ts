/**
 * Price lookup and manual-price freshness.
 *
 * Prices are stored as dated points (a daily close, or a price the user typed
 * for a manual asset). To value anything ON a date we use the most recent
 * point on or before that date:
 *
 *   price(asset, date) = close of the latest point with point.date ≤ date
 *
 * For manual assets this means the price is held flat between updates — the
 * same assumption a fund statement makes between valuation days.
 */

import { Dec } from '../money/decimal';
import { daysBetween, type IsoDate } from '../calendar/dates';
import type { Id, PricePoint } from '../types';

export interface DatedPrice {
  price: Dec;
  date: IsoDate;
  source: PricePoint['source'];
}

/** Latest point on or before `date` (or the latest overall when `date` is omitted). */
export function priceOnOrBefore(points: readonly PricePoint[], date?: IsoDate): DatedPrice | undefined {
  let best: PricePoint | undefined;
  for (const p of points) {
    if (date && p.date > date) continue;
    if (!best || p.date > best.date) best = p;
  }
  return best && { price: Dec.from(best.close), date: best.date, source: best.source };
}

/** Groups points by instrument and picks each one's price on or before `date`. */
export function pricesOnOrBefore(points: readonly PricePoint[], date?: IsoDate): Map<Id, DatedPrice> {
  const byInstrument = new Map<Id, PricePoint[]>();
  for (const p of points) {
    const list = byInstrument.get(p.instrumentId);
    if (list) list.push(p);
    else byInstrument.set(p.instrumentId, [p]);
  }
  const out = new Map<Id, DatedPrice>();
  for (const [id, list] of byInstrument) {
    const dp = priceOnOrBefore(list, date);
    if (dp) out.set(id, dp);
  }
  return out;
}

/** Just the numbers, for valuePortfolio(). */
export function priceMap(prices: ReadonlyMap<Id, DatedPrice>): Map<Id, Dec> {
  return new Map([...prices].map(([id, dp]) => [id, dp.price]));
}

export interface ManualPriceStatus {
  ageDays: number;
  /** True when a reminder interval is set and the price is at least that old. */
  updateDue: boolean;
}

export function manualPriceStatus(lastPriceDate: IsoDate, today: IsoDate, reminderDays?: number): ManualPriceStatus {
  const ageDays = Math.max(0, daysBetween(lastPriceDate, today));
  return { ageDays, updateDue: reminderDays !== undefined && reminderDays > 0 && ageDays >= reminderDays };
}

/** "today", "yesterday", "6 days ago", "3 weeks ago" */
export function describeAge(ageDays: number): string {
  if (ageDays <= 0) return 'today';
  if (ageDays === 1) return 'yesterday';
  if (ageDays < 14) return `${ageDays} days ago`;
  if (ageDays < 60) return `${Math.floor(ageDays / 7)} weeks ago`;
  return `${Math.floor(ageDays / 30)} months ago`;
}
