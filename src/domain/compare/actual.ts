/**
 * Actual track record over a period — the second view on the Compare screen.
 *
 * Unlike the equal-money backtest, this uses each portfolio's REAL ledger
 * (its own contributions, timing and changes of mix), with the effect of new
 * money removed by the time-weighted index (see portfolio/history.ts):
 *   I_base = 1,   I_t = I_{t−1} × (V_t − F_t) / V_{t−1}
 * Metrics (metrics.ts) are then computed on that index.
 */

import type { IsoDate } from '../calendar/dates';
import type { DayValue } from '../portfolio/history';
import { metricsOf, type DatedValue, type Metrics } from './metrics';

export interface ActualPerformance {
  metrics: Metrics | null;
  /** First date measured (later than the period start when history is shorter). */
  since: IsoDate;
  partial: boolean;
  index: DatedValue[];
}

export function twrIndexSeries(series: readonly DayValue[]): DatedValue[] {
  const out: DatedValue[] = [];
  let idx = 100;
  for (let i = 0; i < series.length; i++) {
    const cur = series[i]!;
    const prev = series[i - 1];
    if (prev && prev.value > 0) idx *= (cur.value - (cur.invested - prev.invested)) / prev.value;
    if (prev?.value || cur.value > 0) out.push({ date: cur.date, value: idx });
  }
  return out;
}

export function actualPerformance(series: readonly DayValue[], start: IsoDate | null): ActualPerformance | null {
  if (series.length === 0) return null;
  let base = 0;
  if (start) for (let i = 0; i < series.length; i++) if (series[i]!.date <= start) base = i;
  const window = series.slice(base);
  const index = twrIndexSeries(window);
  if (index.length === 0) return null;
  return { metrics: metricsOf(index), since: index[0]!.date, partial: start !== null && series[0]!.date > start, index };
}
