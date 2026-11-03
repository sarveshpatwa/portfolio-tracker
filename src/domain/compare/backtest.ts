/**
 * Equal-money backtest — the headline answer to "if the same amount went into
 * each of my portfolios, which would have done best?"
 *
 * For every portfolio:
 *  1. Take its MIX — either today's holdings by value (cash included as cash)
 *     or its target allocation.
 *  2. On the common start date, "invest" the same AMOUNT in that mix:
 *       units_i = amount × weight_i ÷ price_i(start)      cash = amount × cashWeight
 *  3. Hold (no rebalancing, no new money) and value every trading day:
 *       value(d) = cash + Σ units_i × price_i(d)
 *  4. Rank by final value.
 *
 * Prices: market closes (a live price only counts on the end date); manual and
 * Vanguard-linked prices are held flat between updates.
 *
 * Common start: every asset in every mix needs a price on the start date. If
 * the requested start is earlier than some asset's first price, the start
 * moves forward to that date and `limitedBy` names the asset — unless
 * `assumeFlatBefore` is on, in which case an asset's first known price is
 * used for earlier days (fine for stable $1.00 funds, rough for others).
 *
 * Not included: dividends (unless already in the price), fees, taxes.
 */

import { addDays, type IsoDate } from '../calendar/dates';
import { isTradingDay } from '../calendar/usMarket';
import type { Id, PricePoint } from '../types';
import { metricsOf, type DatedValue, type Metrics } from './metrics';

export interface Mix {
  portfolioId: Id;
  name: string;
  /** Weights 0–1 per asset; whatever is left of 1 is cash. */
  lines: { instrumentId: Id; weight: number }[];
}

export interface BacktestOptions {
  amount: number;
  /** Requested start (null = as early as every asset allows). */
  start: IsoDate | null;
  end: IsoDate;
  assumeFlatBefore: boolean;
}

export interface BacktestResult {
  portfolioId: Id;
  name: string;
  series: DatedValue[];
  metrics: Metrics | null;
}

export interface Backtest {
  start: IsoDate;
  end: IsoDate;
  /** Set when the start had to move later than requested. */
  limitedBy?: { instrumentId: Id; firstDate: IsoDate };
  /** Ranked best (highest final value) first. */
  results: BacktestResult[];
}

type Price = { date: IsoDate; close: number };

function priceTable(points: readonly PricePoint[], end: IsoDate): Map<Id, Price[]> {
  const by = new Map<Id, Price[]>();
  for (const p of points) {
    if (p.date > end || (p.intraday && p.date !== end)) continue;
    let list = by.get(p.instrumentId);
    if (!list) by.set(p.instrumentId, (list = []));
    list.push({ date: p.date, close: Number(p.close) });
  }
  for (const list of by.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return by;
}

function priceAt(list: readonly Price[] | undefined, day: IsoDate, flatBefore: boolean): number | null {
  if (!list || list.length === 0) return null;
  let found: Price | undefined;
  for (const p of list) {
    if (p.date > day) break;
    found = p;
  }
  return found ? found.close : flatBefore ? list[0]!.close : null;
}

export function runBacktest(mixes: readonly Mix[], points: readonly PricePoint[], opts: BacktestOptions): Backtest | null {
  const table = priceTable(points, opts.end);
  const used = [...new Set(mixes.flatMap((m) => m.lines.filter((l) => l.weight > 0).map((l) => l.instrumentId)))];
  if (mixes.length === 0) return null;

  // Earliest date every asset has a price.
  let limitedBy: Backtest['limitedBy'];
  let earliestAll: IsoDate | undefined;
  let latestFirst: { instrumentId: Id; firstDate: IsoDate } | undefined;
  for (const id of used) {
    const first = table.get(id)?.[0]?.date;
    if (!first) return null; // an asset with no price at all can't be backtested
    if (!earliestAll || first < earliestAll) earliestAll = first;
    if (!latestFirst || first > latestFirst.firstDate) latestFirst = { instrumentId: id, firstDate: first };
  }
  let start = opts.start ?? (opts.assumeFlatBefore ? earliestAll : latestFirst?.firstDate) ?? opts.end;
  if (!opts.assumeFlatBefore && latestFirst && latestFirst.firstDate > start) {
    start = latestFirst.firstDate;
    if (opts.start) limitedBy = latestFirst;
  }
  if (start > opts.end) start = opts.end;

  const days: IsoDate[] = [];
  for (let d = start; d <= opts.end; d = addDays(d, 1)) if (d === start || d === opts.end || isTradingDay(d)) days.push(d);

  const results: BacktestResult[] = mixes.map((mix) => {
    const lines = mix.lines.filter((l) => l.weight > 0);
    const invested = lines.reduce((a, l) => a + l.weight, 0);
    const cash = opts.amount * Math.max(0, 1 - invested);
    const units = lines.map((l) => {
      const p0 = priceAt(table.get(l.instrumentId), start, opts.assumeFlatBefore);
      return { id: l.instrumentId, units: p0 && p0 > 0 ? (opts.amount * l.weight) / p0 : 0 };
    });
    const series = days.map((day) => ({
      date: day,
      value: cash + units.reduce((a, u) => a + u.units * (priceAt(table.get(u.id), day, opts.assumeFlatBefore) ?? 0), 0),
    }));
    return { portfolioId: mix.portfolioId, name: mix.name, series, metrics: metricsOf(series) };
  });
  results.sort((a, b) => (b.series[b.series.length - 1]?.value ?? 0) - (a.series[a.series.length - 1]?.value ?? 0));
  return { start, end: opts.end, ...(limitedBy ? { limitedBy } : {}), results };
}

export type ComparePeriod = '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'Max';
export const COMPARE_PERIODS: readonly ComparePeriod[] = ['3M', '6M', '1Y', '3Y', '5Y', 'Max'];

export function periodStart(period: ComparePeriod, end: IsoDate): IsoDate | null {
  const months = { '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60, Max: 0 }[period];
  if (!months) return null;
  const [y, m, d] = end.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const yy = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
