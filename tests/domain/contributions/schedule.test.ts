import { describe, expect, it } from 'vitest';
import { dueContributions, nextScheduledDate, scheduledDates } from '../../../src/domain/contributions/schedule';
import type { ContributionRule } from '../../../src/domain/types';

const rule = (fields: Partial<ContributionRule>): ContributionRule => ({
  id: 'r1',
  portfolioId: 'p1',
  amount: '500',
  frequency: 'monthly',
  startDate: '2026-01-31',
  paused: false,
  createdAt: '',
  ...fields,
});

describe('scheduledDates', () => {
  it('clamps monthly dates to month end without drifting', () => {
    expect(scheduledDates(rule({}), '2026-05-31')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('supports weekly, biweekly and quarterly', () => {
    expect(scheduledDates(rule({ frequency: 'weekly', startDate: '2026-10-01' }), '2026-10-22')).toHaveLength(4);
    expect(scheduledDates(rule({ frequency: 'biweekly', startDate: '2026-10-01' }), '2026-10-29')).toEqual([
      '2026-10-01',
      '2026-10-15',
      '2026-10-29',
    ]);
    expect(scheduledDates(rule({ frequency: 'quarterly', startDate: '2026-01-15' }), '2026-12-31')).toEqual([
      '2026-01-15',
      '2026-04-15',
      '2026-07-15',
      '2026-10-15',
    ]);
  });

  it('stops at the end date', () => {
    expect(scheduledDates(rule({ startDate: '2026-01-10', endDate: '2026-03-10' }), '2026-12-31')).toHaveLength(3);
  });
});

describe('dueContributions (catch-up)', () => {
  it('returns every missed date since the last processed one, each on a trading day', () => {
    const r = rule({ startDate: '2026-07-06', lastScheduledDate: '2026-07-06' });
    expect(dueContributions(r, '2026-10-30')).toEqual([
      { scheduledDate: '2026-08-06', tradeDate: '2026-08-06' },
      { scheduledDate: '2026-09-06', tradeDate: '2026-09-08' }, // Sunday + Labor Day
      { scheduledDate: '2026-10-06', tradeDate: '2026-10-06' },
    ]);
  });

  it('waits when the trade date is still in the future', () => {
    // Scheduled Saturday Oct 31 → trades Monday Nov 2, not yet due on Oct 31.
    const r = rule({ startDate: '2026-10-31' });
    expect(dueContributions(r, '2026-10-31')).toEqual([]);
    expect(dueContributions(r, '2026-11-02')).toEqual([{ scheduledDate: '2026-10-31', tradeDate: '2026-11-02' }]);
  });

  it('does nothing while paused', () => {
    expect(dueContributions(rule({ paused: true, startDate: '2026-01-05' }), '2026-10-30')).toEqual([]);
  });
});

describe('nextScheduledDate', () => {
  it('finds the next date after today', () => {
    expect(nextScheduledDate(rule({ startDate: '2025-01-06' }), '2026-10-30')).toBe('2026-11-06');
    expect(nextScheduledDate(rule({ startDate: '2025-01-06', endDate: '2026-10-01' }), '2026-10-30')).toBeUndefined();
  });
});
