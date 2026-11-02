import { describe, expect, it } from 'vitest';
import { parseOneTime, parseRule } from '../../../src/domain/contributions/forms';

describe('parseOneTime', () => {
  it('accepts an amount and defaults the date to today', () => {
    const r = parseOneTime({ amount: '$1,000', date: '' }, '2026-11-02');
    expect(r.ok && r.amount.toString()).toBe('1000');
    expect(r.ok && r.date).toBe('2026-11-02');
  });

  it('rejects zero, sub-cent and future-dated contributions', () => {
    const r = parseOneTime({ amount: '0', date: '2026-12-01' }, '2026-11-02');
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['amount', 'date']);
    const cents = parseOneTime({ amount: '10.005', date: '' }, '2026-11-02');
    expect(!cents.ok && cents.errors.amount).toBe('Use at most 2 decimal places (cents).');
  });
});

describe('parseRule', () => {
  it('accepts a past start (back-fill) and an optional end date', () => {
    const r = parseRule({ amount: '500', frequency: 'monthly', startDate: '2025-01-06', endDate: '' });
    expect(r.ok && r.value.startDate).toBe('2025-01-06');
    expect(r.ok && r.value.endDate).toBeUndefined();
  });

  it('validates every field', () => {
    const r = parseRule({ amount: '-5', frequency: 'daily' as never, startDate: '', endDate: 'x' });
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['amount', 'endDate', 'frequency', 'startDate']);
    const order = parseRule({ amount: '5', frequency: 'weekly', startDate: '2026-05-01', endDate: '2026-04-01' });
    expect(!order.ok && order.errors.endDate).toBe('The end date must be after the start date.');
  });
});
