/**
 * Value history and returns — the engine behind the performance chart, and
 * later the risk profile (step 8) and the Compare screen (step 9).
 *
 * Daily value
 * -----------
 * For every US trading day from the first ledger entry to `endDate`:
 *   value(d) = cash(d) + Σ units(d) × price(d)
 * where units and cash come from replaying the ledger up to and including d,
 * and price(d) is the instrument's latest price on or before d:
 *  - market assets: final daily closes (a live intraday price only counts on
 *    `endDate`, so the last point matches the dashboard),
 *  - manual assets: the last price you entered (or fetched) on or before d —
 *    held flat between updates, like a fund statement.
 * Before an instrument's first known price, its cost basis is used (so the
 * line doesn't dip to zero right after buying). An instrument with no price at
 * all counts as 0, exactly like the dashboard.
 *
 * invested(d) = net money put in (deposits − withdrawals + opening positions).
 *
 * Time-weighted return (TWR)
 * --------------------------
 * Measures growth with the timing of contributions removed, so adding $5,000
 * doesn't look like a gain. With flows F_t = invested(t) − invested(t−1),
 * assumed to happen at the end of day t:
 *   r_t = (V_t − F_t) / V_{t−1} − 1           (days with V_{t−1} ≤ 0 are skipped)
 *   TWR = Π (1 + r_t) − 1
 * Fees and income in units change value but not `invested`, so they count as
 * negative/positive return — as they should.
 *
 * Annualised (CAGR) = (1 + TWR)^(365.25 / calendar days) − 1. Only reported
 * with at least MIN_DAYS_FOR_CAGR days of history: annualising a few weeks
 * produces absurd numbers.
 */

import { Dec } from '../money/decimal';
import { addMonths, addDays, daysBetween, type IsoDate } from '../calendar/dates';
import { isTradingDay } from '../calendar/usMarket';
import { applyTransaction, emptyLedgerState, sortTransactions, type LedgerState } from './ledger';
import type { Id, PricePoint, Transaction } from '../types';

export interface DayValue {
  date: IsoDate;
  value: number;
  invested: number;
}

export const MIN_DAYS_FOR_CAGR = 90;

export function valueHistory(txs: readonly Transaction[], points: readonly PricePoint[], endDate: IsoDate): DayValue[] {
  const sorted = sortTransactions(txs).filter((t) => t.date <= endDate);
  if (sorted.length === 0) return [];
  const first = sorted[0]!.date;

  // Per-instrument prices, oldest first; intraday points only count on endDate.
  const byInst = new Map<Id, { date: IsoDate; close: Dec }[]>();
  for (const p of points) {
    if (p.intraday && p.date !== endDate) continue;
    if (p.date > endDate) continue;
    let list = byInst.get(p.instrumentId);
    if (!list) byInst.set(p.instrumentId, (list = []));
    list.push({ date: p.date, close: Dec.from(p.close) });
  }
  for (const list of byInst.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const cursor = new Map<Id, number>(); // index of the latest point ≤ current day

  const days: IsoDate[] = [];
  for (let d = first; d <= endDate; d = addDays(d, 1)) if (d === first || d === endDate || isTradingDay(d)) days.push(d);

  const out: DayValue[] = [];
  const state: LedgerState = emptyLedgerState();
  let applied = 0;
  for (const day of days) {
    // Incremental replay: apply the entries dated up to this day, in ledger order.
    while (applied < sorted.length && sorted[applied]!.date <= day) applyTransaction(state, sorted[applied++]!);
    let value = state.cash;
    for (const pos of state.positions.values()) {
      if (pos.quantity.isZero()) continue;
      const list = byInst.get(pos.instrumentId);
      if (!list || list.length === 0) continue; // never priced → 0, like the dashboard
      let i = cursor.get(pos.instrumentId) ?? -1;
      while (i + 1 < list.length && list[i + 1]!.date <= day) i++;
      cursor.set(pos.instrumentId, i);
      value = value.add(i >= 0 ? pos.quantity.mul(list[i]!.close) : pos.costBasis);
    }
    out.push({ date: day, value: value.toNumber(), invested: state.netInvested.toNumber() });
  }
  return out;
}

/** Time-weighted return between series[fromIndex] (the base) and the last point. */
export function twr(series: readonly DayValue[], fromIndex = 0): number {
  let growth = 1;
  for (let t = Math.max(1, fromIndex + 1); t < series.length; t++) {
    const prev = series[t - 1]!;
    const cur = series[t]!;
    if (prev.value <= 0) continue;
    const flow = cur.invested - prev.invested;
    growth *= (cur.value - flow) / prev.value;
  }
  return growth - 1;
}

export type RangeKey = '1D' | '1W' | '1M' | '1Y' | 'All';
export const RANGES: readonly RangeKey[] = ['1D', '1W', '1M', '1Y', 'All'];

export interface RangeResult {
  /** Points to draw: the base (previous close before the range) + the range. */
  points: DayValue[];
  /** Time-weighted return over the range. */
  returnPct: number;
  /** Change in gain over the range: market movement in dollars, excluding new money. */
  gainChange: number;
  /** True when history is shorter than the range (the whole history is shown). */
  partial: boolean;
}


/** Start date of a range ending on `end`. */
export function rangeStart(range: RangeKey, end: IsoDate): IsoDate | null {
  switch (range) {
    case '1D':
      return end;
    case '1W':
      return addDays(end, -7);
    case '1M':
      return addMonths(end, -1);
    case '1Y':
      return addMonths(end, -12);
    case 'All':
      return null;
  }
}

export function rangeOf(all: readonly DayValue[], range: RangeKey): RangeResult | null {
  if (all.length === 0) return null;
  // 1D on a weekend/holiday shows the last trading day's move (like a broker app).
  const lastAll = all[all.length - 1]!;
  const series = range === '1D' && all.length > 1 && !isTradingDay(lastAll.date) ? all.slice(0, -1) : all;
  const end = series[series.length - 1]!.date;
  const start = rangeStart(range, end);
  // Base = last point strictly before the range start (for 1D: the previous trading day).
  let baseIndex = 0;
  let partial = false;
  if (start !== null) {
    const firstIn = series.findIndex((p) => (range === '1D' ? p.date >= start : p.date > start));
    const idx = firstIn === -1 ? series.length - 1 : firstIn;
    baseIndex = Math.max(0, idx - 1);
    partial = series[0]!.date > start || (range === '1D' && series.length < 2);
  }
  const points = series.slice(baseIndex);
  const base = points[0]!;
  const last = points[points.length - 1]!;
  return {
    points,
    returnPct: twr(series, baseIndex),
    gainChange: last.value - last.invested - (base.value - base.invested),
    partial,
  };
}

/** Annualised time-weighted return, or null with less than MIN_DAYS_FOR_CAGR days of history. */
export function cagr(series: readonly DayValue[]): { rate: number; days: number } | null {
  if (series.length < 2) return null;
  const days = daysBetween(series[0]!.date, series[series.length - 1]!.date);
  if (days < MIN_DAYS_FOR_CAGR) return null;
  const total = twr(series);
  if (total <= -1) return { rate: -1, days };
  return { rate: Math.pow(1 + total, 365.25 / days) - 1, days };
}

/** Evenly thinned series for small sparklines (keeps first and last). */
export function thin(series: readonly DayValue[], maxPoints: number): DayValue[] {
  if (series.length <= maxPoints) return [...series];
  const out: DayValue[] = [];
  const step = (series.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(series[Math.round(i * step)]!);
  return out;
}
