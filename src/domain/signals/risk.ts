/**
 * Portfolio risk profile: three measures, each scored 0 (low) / 1 (medium) /
 * 2 (high), averaged into Low / Medium / High.
 *
 *  1. Volatility — how much the value swings: annualised standard deviation of
 *     daily time-weighted returns over the last year (money added or removed
 *     is taken out, see portfolio/history.ts).
 *        < 10% → low · 10–18% → medium · > 18% → high
 *     (For reference: a broad bond fund is often ~5%, a broad stock index ~15–20%.)
 *  2. Largest drop — the worst peak-to-trough fall of the time-weighted value
 *     index over the whole history.
 *        smaller than 10% → low · 10–25% → medium · more than 25% → high
 *  3. Concentration — the largest holding's share of the portfolio.
 *        < 25% → low · 25–50% → medium · > 50% → high
 *     Also shown: "effective number of holdings" = 1 / Σ wᵢ²
 *     (10 equal holdings → 10; one dominant holding → close to 1).
 *
 * Score = mean of the available measures' points: < 0.67 Low, < 1.34 Medium,
 * otherwise High. Volatility and largest drop need MIN_RISK_DAYS of history;
 * before that only concentration is scored, and the result says so.
 */

import { daysBetween } from '../calendar/dates';
import { isTradingDay } from '../calendar/usMarket';
import type { DayValue } from '../portfolio/history';
import { annualVolatility, maxDrawdown } from './indicators';

export const MIN_RISK_DAYS = 60;

export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface RiskMeasure {
  key: 'volatility' | 'drawdown' | 'concentration';
  label: string;
  value: number | null;
  display: string;
  points: 0 | 1 | 2 | null;
  explain: string;
}

export interface RiskProfile {
  level: RiskLevel | null;
  measures: RiskMeasure[];
  /** True when only concentration could be scored. */
  limitedHistory: boolean;
  historyDays: number;
  /** Share of value in assets with sparse (manual) prices — their swings are understated. */
  sparseWeight: number;
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

/** Time-weighted index (starts at 1) from a value history, on trading days only. */
export function twrIndex(series: readonly DayValue[]): number[] {
  const out: number[] = [];
  let idx = 1;
  let prev: DayValue | undefined;
  for (const d of series) {
    if (!isTradingDay(d.date) && d !== series[series.length - 1]) continue;
    if (prev && prev.value > 0) idx *= (d.value - (d.invested - prev.invested)) / prev.value;
    if (prev || d.value > 0) out.push(idx);
    prev = d;
  }
  return out;
}

export function riskProfile(series: readonly DayValue[], weights: readonly number[], sparseWeight = 0): RiskProfile {
  const historyDays = series.length > 1 ? daysBetween(series[0]!.date, series[series.length - 1]!.date) : 0;
  const enough = historyDays >= MIN_RISK_DAYS;
  const index = twrIndex(series);
  const measures: RiskMeasure[] = [];

  // 1. Volatility (last ~year of trading days)
  if (enough && index.length > 20) {
    const tail = index.slice(-253);
    const r: number[] = [];
    for (let i = 1; i < tail.length; i++) r.push(tail[i]! / tail[i - 1]! - 1);
    const vol = annualVolatility(r);
    measures.push({
      key: 'volatility',
      label: 'Volatility',
      value: vol,
      display: `${pct(vol)} a year`,
      points: vol < 0.1 ? 0 : vol <= 0.18 ? 1 : 2,
      explain: `How much the value swings day to day, scaled to a year. Under 10% is calm (bond-like); a broad stock index is usually 15–20%.`,
    });
  } else {
    measures.push({ key: 'volatility', label: 'Volatility', value: null, display: 'Needs more history', points: null, explain: `Shown after ${MIN_RISK_DAYS} days of history.` });
  }

  // 2. Largest drop (whole history)
  if (enough && index.length > 1) {
    const dd = maxDrawdown(index).drawdown;
    measures.push({
      key: 'drawdown',
      label: 'Largest drop',
      value: dd,
      display: dd === 0 ? 'None yet' : `−${pct(-dd)}`,
      points: dd > -0.1 ? 0 : dd >= -0.25 ? 1 : 2,
      explain: 'The biggest fall from a high point to a later low, with money you added taken out. It shows what a bad stretch has felt like so far.',
    });
  } else {
    measures.push({ key: 'drawdown', label: 'Largest drop', value: null, display: 'Needs more history', points: null, explain: `Shown after ${MIN_RISK_DAYS} days of history.` });
  }

  // 3. Concentration
  const pos = weights.filter((w) => w > 0);
  if (pos.length > 0) {
    const top = Math.max(...pos);
    const effective = 1 / pos.reduce((a, w) => a + w * w, 0);
    measures.push({
      key: 'concentration',
      label: 'Concentration',
      value: top,
      display: `Largest ${pct(top, 0)}`,
      points: top < 0.25 ? 0 : top <= 0.5 ? 1 : 2,
      explain: `The largest holding’s share (cash counts as one). This mix behaves like about ${effective.toFixed(1)} equal-sized holdings — the more, the less one bad holding hurts.`,
    });
  } else {
    measures.push({ key: 'concentration', label: 'Concentration', value: null, display: 'No holdings yet', points: null, explain: 'Shown once the portfolio holds something.' });
  }

  const scored = measures.map((m) => m.points).filter((p): p is 0 | 1 | 2 => p !== null);
  const mean = scored.length ? scored.reduce<number>((a, b) => a + b, 0) / scored.length : null;
  const level: RiskLevel | null = mean === null ? null : mean < 0.67 ? 'Low' : mean < 1.34 ? 'Medium' : 'High';
  return { level, measures, limitedHistory: !enough, historyDays, sparseWeight };
}
