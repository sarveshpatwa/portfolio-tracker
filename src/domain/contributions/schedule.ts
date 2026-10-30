/**
 * Recurring contribution schedule and catch-up.
 *
 * Scheduled dates are computed from the ORIGINAL start date
 * (start + n × interval), so a rule starting on the 31st lands on the last day
 * of short months and returns to the 31st afterwards instead of drifting.
 *
 * Each scheduled date is executed on a trading day:
 *   tradeDate = first trading day on or after the scheduled date
 * (weekend/holiday → next trading day). The purchase uses that day's closing
 * price, which is how missed dates are caught up when the app was closed.
 *
 * A scheduled date is "due" when its trade date is on or before `today`.
 * Whether today's close exists yet (market still open) is the price layer's
 * concern, not the schedule's.
 */

import { addDays, addMonths, type IsoDate } from '../calendar/dates';
import { nextTradingDayOnOrAfter } from '../calendar/usMarket';
import type { ContributionRule, Frequency } from '../types';

export interface DueContribution {
  scheduledDate: IsoDate;
  tradeDate: IsoDate;
}

/** Safety cap so a corrupt rule can't create an endless loop (≈ 40 years of weekly buys). */
const MAX_OCCURRENCES = 2_100;

export function nthOccurrence(startDate: IsoDate, frequency: Frequency, n: number): IsoDate {
  switch (frequency) {
    case 'weekly':
      return addDays(startDate, 7 * n);
    case 'biweekly':
      return addDays(startDate, 14 * n);
    case 'monthly':
      return addMonths(startDate, n);
    case 'quarterly':
      return addMonths(startDate, 3 * n);
  }
}

/** Scheduled dates in (after, through], ignoring pause/end. `after` undefined = from the start. */
export function scheduledDates(
  rule: Pick<ContributionRule, 'startDate' | 'frequency' | 'endDate'>,
  through: IsoDate,
  after?: IsoDate,
): IsoDate[] {
  const out: IsoDate[] = [];
  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    const date = nthOccurrence(rule.startDate, rule.frequency, n);
    if (date > through) break;
    if (rule.endDate && date > rule.endDate) break;
    if (after && date <= after) continue;
    out.push(date);
  }
  return out;
}

/**
 * Contributions that should have happened by `today` but haven't been
 * processed yet (scheduled after rule.lastScheduledDate).
 */
export function dueContributions(rule: ContributionRule, today: IsoDate): DueContribution[] {
  if (rule.paused) return [];
  return scheduledDates(rule, today, rule.lastScheduledDate)
    .map((scheduledDate) => ({ scheduledDate, tradeDate: nextTradingDayOnOrAfter(scheduledDate) }))
    .filter((c) => c.tradeDate <= today);
}

/** The next scheduled date strictly after `today`, for "next buy Nov 6". */
export function nextScheduledDate(rule: ContributionRule, today: IsoDate): IsoDate | undefined {
  if (rule.paused) return undefined;
  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    const date = nthOccurrence(rule.startDate, rule.frequency, n);
    if (rule.endDate && date > rule.endDate) return undefined;
    if (date > today) return date;
  }
  return undefined;
}
