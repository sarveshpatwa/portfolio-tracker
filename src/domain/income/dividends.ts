/**
 * $1.00 income funds (money market and stable value funds).
 *
 * The price stays at $1.00; income arrives as new units. Each day the fund
 * declares a rate per unit; the month's "distribution" is the sum of those
 * daily rates, paid as new units on the first business day of the next month.
 *
 * Estimate used here (the 7-day SEC yield stands in for the daily rate):
 *   rate(d)      = SEC yield in effect on day d ÷ 100 ÷ 365     (per unit per day)
 *   units(d)     = units held at the END of the previous day — purchases start
 *                  earning the day after they're bought
 *   dividend(M)  = Σ over every calendar day d of month M: units(d) × rate(d)
 *   (weekends and holidays earn too; the yield in effect carries over)
 *
 * Example (October 2026): a 3.84% average rate on ≈6,278 average units ≈ 20.48.
 *
 * Booking: on the payable date (first US trading day of the next month) the
 * estimate is booked as a REINVEST of that many units at $1.00, marked
 * `estimated`, with the fixed id div:<instrument>:<portfolio>:<YYYY-MM> (so two
 * devices never double it). Entering the statement amount replaces it.
 * Only months paid AFTER income tracking was turned on are booked, so
 * dividends you entered by hand before aren't doubled.
 */

import { Dec } from '../money/decimal';
import { addDays, type IsoDate } from '../calendar/dates';
import { nextTradingDayOnOrAfter } from '../calendar/usMarket';
import type { Id, Instrument, Transaction, YieldEntry } from '../types';

export type Month = string; // YYYY-MM

export const monthOf = (d: IsoDate): Month => d.slice(0, 7);
export const firstDay = (m: Month): IsoDate => `${m}-01`;
export function nextMonth(m: Month): Month {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}
export const lastDay = (m: Month): IsoDate => addDays(firstDay(nextMonth(m)), -1);

/** Dividends for month M are paid on the first trading day of the next month. */
export const payableDate = (m: Month): IsoDate => nextTradingDayOnOrAfter(firstDay(nextMonth(m)));

export const dividendId = (instrumentId: Id, portfolioId: Id, m: Month) => `div:${instrumentId}:${portfolioId}:${m}`;

/** Yield (%) in effect on a day: the latest entry on or before it, else the earliest one. */
export function yieldOn(yields: NonNullable<Instrument['income']>['yields'], day: IsoDate): number | null {
  if (yields.length === 0) return null;
  const sorted = [...yields].sort((a, b) => (a.date < b.date ? -1 : 1));
  let found = sorted[0]!;
  for (const y of sorted) if (y.date <= day) found = y;
  return Number(found.pct);
}

/** Units of one instrument held at the end of each day, from its ledger entries. */
function unitsBefore(txs: readonly Transaction[], instrumentId: Id, day: IsoDate): number {
  let q = 0;
  for (const t of txs) {
    if (t.instrumentId !== instrumentId || !t.quantity || t.date >= day) continue;
    const n = Number(t.quantity);
    if (t.type === 'BUY' || t.type === 'OPENING' || t.type === 'REINVEST') q += n;
    else if (t.type === 'SELL') q -= n;
  }
  return q;
}

export interface MonthEstimate {
  month: Month;
  /** Estimated dividend (units = dollars at $1.00), not rounded. */
  amount: number;
  /** Average units earning over the days counted. */
  averageUnits: number;
  days: number;
}

/** Estimate for month M, counting days up to `through` (inclusive; default the whole month). */
export function estimateMonth(
  txs: readonly Transaction[],
  instrumentId: Id,
  yields: NonNullable<Instrument['income']>['yields'],
  m: Month,
  through?: IsoDate,
): MonthEstimate | null {
  const end = through && through < lastDay(m) ? through : lastDay(m);
  let amount = 0;
  let unitDays = 0;
  let days = 0;
  for (let d = firstDay(m); d <= end; d = addDays(d, 1)) {
    const y = yieldOn(yields, d);
    if (y === null) return null;
    const units = Math.max(0, unitsBefore(txs, instrumentId, d));
    amount += (units * y) / 100 / 365;
    unitDays += units;
    days++;
  }
  return { month: m, amount, averageUnits: days ? unitDays / days : 0, days };
}

/** Rounded to cents (= hundredths of a unit at $1.00). */
export const toUnits = (amount: number): Dec => Dec.from(amount.toFixed(2));

/** Dividend entries now due (estimated), for one fund in one portfolio. */
export function dueDividends(args: {
  instrument: Instrument;
  portfolioId: Id;
  txs: readonly Transaction[];
  today: IsoDate;
  nextSeq: () => number;
  now: string;
}): Transaction[] {
  const income = args.instrument.income;
  if (!income || income.yields.length === 0) return [];
  const booked = new Set(args.txs.map((t) => t.id));
  const out: Transaction[] = [];
  // Months whose payable date is after tracking was turned on, up to today.
  let m = monthOf(income.since);
  if (payableDate(m) <= income.since) m = nextMonth(m);
  // ...but never before a month in which the fund was held at all.
  const held = args.txs.filter((t) => t.instrumentId === args.instrument.id).map((t) => t.date).sort()[0];
  if (!held) return [];
  if (m < monthOf(held)) m = monthOf(held);
  for (; payableDate(m) <= args.today; m = nextMonth(m)) {
    const id = dividendId(args.instrument.id, args.portfolioId, m);
    if (booked.has(id)) continue;
    const est = estimateMonth([...args.txs, ...out], args.instrument.id, income.yields, m);
    if (!est) continue;
    const units = toUnits(est.amount);
    if (!units.isPositive()) continue;
    out.push({
      id,
      seq: args.nextSeq(),
      portfolioId: args.portfolioId,
      type: 'REINVEST',
      date: payableDate(m),
      instrumentId: args.instrument.id,
      quantity: units.toString(),
      price: '1',
      amount: units.toString(),
      note: `Dividend ${m} (estimated)`,
      estimated: true,
      createdAt: args.now,
    });
  }
  return out;
}

/** The booked entry replaced by the statement amount. */
export function correctedDividend(tx: Transaction, actualUnits: Dec, now: string): Transaction {
  const { estimated: _e, ...rest } = tx;
  const m = tx.id.split(':').pop()!;
  return { ...rest, quantity: actualUnits.toString(), amount: actualUnits.toString(), note: `Dividend ${m} (actual)`, updatedAt: now };
}

/**
 * Adds a yield fetched with the Vanguard price. A yield you typed for the same
 * date wins; a fetched one is replaced when Vanguard revises it. Returns null
 * when nothing changes.
 */
export function withFetchedYield(yields: readonly YieldEntry[], fetched: { date: IsoDate; pct: string; days?: 7 | 30 }): YieldEntry[] | null {
  const same = yields.find((y) => y.date === fetched.date);
  if (same && (same.source !== 'fetched' || (same.pct === fetched.pct && same.days === fetched.days))) return null;
  const entry: YieldEntry = { date: fetched.date, pct: fetched.pct, source: 'fetched', ...(fetched.days ? { days: fetched.days } : {}) };
  return [...yields.filter((y) => y.date !== fetched.date), entry].sort((a, b) => (a.date < b.date ? -1 : 1));
}
