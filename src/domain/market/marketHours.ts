/**
 * US market session, computed on New York wall-clock time so it stays right
 * across daylight-saving changes and regardless of the device's time zone
 * (9:30 ET is 19:00 IST in US summer and 20:00 IST in US winter).
 *
 *   regular session: 09:30 ≤ time < 16:00 ET on trading days
 *
 * After 16:00 the day's quote is the closing price. We treat a day's close as
 * final from 16:15 ET, leaving a margin for late prints.
 */

import { addDays, type IsoDate } from '../calendar/dates';
import { isTradingDay, previousTradingDayOnOrBefore } from '../calendar/usMarket';

export type Session = 'pre-market' | 'open' | 'after-close' | 'closed-day';

const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;
const FINAL_MIN = CLOSE_MIN + 15;

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** New York calendar date and minutes since midnight for an instant. */
export function nyClock(now: Date): { date: IsoDate; minutes: number } {
  const parts = Object.fromEntries(nyFormat.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function marketSession(now: Date): Session {
  const { date, minutes } = nyClock(now);
  if (!isTradingDay(date)) return 'closed-day';
  if (minutes < OPEN_MIN) return 'pre-market';
  if (minutes < CLOSE_MIN) return 'open';
  return 'after-close';
}

export function isMarketOpen(now: Date): boolean {
  return marketSession(now) === 'open';
}

/** The most recent trading day whose closing price is final. */
export function latestCompletedTradingDay(now: Date): IsoDate {
  const { date, minutes } = nyClock(now);
  if (isTradingDay(date) && minutes >= FINAL_MIN) return date;
  return previousTradingDayOnOrBefore(addDays(date, -1));
}

/** True when a close for today's trading session exists but isn't stored as final yet. */
export function closeIsFinal(now: Date, date: IsoDate): boolean {
  return date <= latestCompletedTradingDay(now);
}
