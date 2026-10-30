import { describe, expect, it } from 'vitest';
import { addMonths, isIsoDate, todayInNewYork } from '../../../src/domain/calendar/dates';
import {
  easterSunday,
  isTradingDay,
  nextTradingDayOnOrAfter,
  previousTradingDayOnOrBefore,
  tradingDaysBetween,
  usMarketHolidays,
} from '../../../src/domain/calendar/usMarket';

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('26-2-1')).toBe(false);
  });

  it('adds months with month-end clamping', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('reports the New York date regardless of device time zone', () => {
    // 02:00 UTC on Oct 31 is still Oct 30 in New York.
    expect(todayInNewYork(new Date('2026-10-31T02:00:00Z'))).toBe('2026-10-30');
  });
});

describe('US market calendar', () => {
  it('computes Easter', () => {
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2026)).toBe('2026-04-05');
  });

  it('lists 2026 NYSE holidays', () => {
    expect([...usMarketHolidays(2026)].sort()).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-04-03',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03', // July 4 is a Saturday → observed Friday
      '2026-09-07',
      '2026-11-26',
      '2026-12-25',
    ]);
  });

  it('handles New Year on a weekend', () => {
    expect(usMarketHolidays(2022).has('2022-01-01')).toBe(false); // Saturday: not moved to Dec 31
    expect(isTradingDay('2021-12-31')).toBe(true);
    expect(usMarketHolidays(2023).has('2023-01-02')).toBe(true); // Sunday → Monday
  });

  it('has no Juneteenth before 2022', () => {
    expect(usMarketHolidays(2021).has('2021-06-18')).toBe(false);
  });

  it('moves to the next / previous trading day', () => {
    // Sep 6 2026 is a Sunday and Sep 7 is Labor Day.
    expect(nextTradingDayOnOrAfter('2026-09-06')).toBe('2026-09-08');
    expect(previousTradingDayOnOrBefore('2026-09-07')).toBe('2026-09-04');
    expect(nextTradingDayOnOrAfter('2026-09-15')).toBe('2026-09-15');
  });

  it('counts trading days in a range', () => {
    expect(tradingDaysBetween('2026-11-23', '2026-11-29')).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-27',
    ]);
  });
});
