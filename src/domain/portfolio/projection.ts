/**
 * Projection ("Estimate") — a straight extrapolation, not a forecast.
 *
 * Assumptions (shown to the user next to the numbers):
 *  - the portfolio keeps growing at its past annualised time-weighted return
 *    (history.ts → cagr), every year, with no ups and downs;
 *  - active recurring contributions continue at their current amount;
 *  - no fees, taxes or withdrawals.
 *
 * Maths (monthly compounding, contributions at the end of each month):
 *   m   = (1 + annualRate)^(1/12) − 1          monthly rate
 *   C   = yearly contributions / 12             monthly contribution
 *   n   = 12 × years
 *   FV  = V × (1 + m)^n + C × ((1 + m)^n − 1) / m      (= V + C × n when m = 0)
 */

import type { ContributionRule, Frequency } from '../types';
import { Dec } from '../money/decimal';
import type { IsoDate } from '../calendar/dates';

export const PROJECTION_YEARS = [1, 5, 10] as const;

const PER_YEAR: Record<Frequency, number> = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4 };

/** Total contributed per year by rules that are running (not paused, not ended). */
export function yearlyContributions(rules: readonly ContributionRule[], today: IsoDate): number {
  let total = 0;
  for (const r of rules) {
    if (r.paused) continue;
    if (r.endDate && r.endDate < today) continue;
    total += Dec.from(r.amount).toNumber() * PER_YEAR[r.frequency];
  }
  return total;
}

export interface ProjectionRow {
  years: number;
  value: number;
  /** New money added over the period. */
  contributed: number;
  /** value − today's value − contributed. */
  growth: number;
}

export function project(currentValue: number, annualRate: number, perYear: number, years: readonly number[] = PROJECTION_YEARS): ProjectionRow[] {
  const m = Math.pow(1 + annualRate, 1 / 12) - 1;
  const c = perYear / 12;
  return years.map((y) => {
    const n = 12 * y;
    const g = Math.pow(1 + m, n);
    const value = Math.abs(m) < 1e-12 ? currentValue + c * n : currentValue * g + (c * (g - 1)) / m;
    const contributed = c * n;
    return { years: y, value, contributed, growth: value - currentValue - contributed };
  });
}
