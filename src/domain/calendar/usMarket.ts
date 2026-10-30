/**
 * US stock market (NYSE/Nasdaq) trading calendar.
 *
 * Full-day closures follow NYSE rules:
 *  - New Year's Day, MLK Day (3rd Mon Jan), Presidents' Day (3rd Mon Feb),
 *    Good Friday, Memorial Day (last Mon May), Juneteenth (Jun 19, since 2022),
 *    Independence Day, Labor Day (1st Mon Sep), Thanksgiving (4th Thu Nov),
 *    Christmas.
 *  - A holiday on Saturday is observed the Friday before; on Sunday, the
 *    Monday after. Exception: when Jan 1 falls on a Saturday the market stays
 *    OPEN on Dec 31 (NYSE avoids closing in the prior year).
 *
 * Not modelled: one-off closures (e.g. national days of mourning) and
 * early 1 pm closes. Early closes still have a closing price, so they don't
 * affect this app. A one-off closure would only mean we look for a price on
 * a day that has none; the price layer then falls back to the previous close.
 */

import { addDays, dayOfWeek, makeIso, parseIso, type IsoDate } from './dates';

const holidayCache = new Map<number, Set<IsoDate>>();

export function usMarketHolidays(year: number): Set<IsoDate> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const days: IsoDate[] = [];

  // New Year's Day — Saturday is NOT moved back to Dec 31 (see header).
  const newYear = makeIso(year, 1, 1);
  if (dayOfWeek(newYear) === 0) days.push(makeIso(year, 1, 2));
  else if (dayOfWeek(newYear) !== 6) days.push(newYear);

  days.push(nthWeekday(year, 1, 1, 3)); // MLK Day: 3rd Monday of January
  days.push(nthWeekday(year, 2, 1, 3)); // Presidents' Day: 3rd Monday of February
  days.push(addDays(easterSunday(year), -2)); // Good Friday
  days.push(lastWeekday(year, 5, 1)); // Memorial Day: last Monday of May
  if (year >= 2022) days.push(observed(makeIso(year, 6, 19))); // Juneteenth
  days.push(observed(makeIso(year, 7, 4))); // Independence Day
  days.push(nthWeekday(year, 9, 1, 1)); // Labor Day: 1st Monday of September
  days.push(nthWeekday(year, 11, 4, 4)); // Thanksgiving: 4th Thursday of November
  days.push(observed(makeIso(year, 12, 25))); // Christmas

  const set = new Set(days);
  holidayCache.set(year, set);
  return set;
}

export function isWeekend(date: IsoDate): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

export function isTradingDay(date: IsoDate): boolean {
  return !isWeekend(date) && !usMarketHolidays(parseIso(date).getUTCFullYear()).has(date);
}

/** The date itself if it's a trading day, otherwise the next one. */
export function nextTradingDayOnOrAfter(date: IsoDate): IsoDate {
  let d = date;
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

/** The date itself if it's a trading day, otherwise the previous one. */
export function previousTradingDayOnOrBefore(date: IsoDate): IsoDate {
  let d = date;
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
}

/** Trading days in [from, to], inclusive. */
export function tradingDaysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(d)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------

/** Saturday → Friday before, Sunday → Monday after. */
function observed(date: IsoDate): IsoDate {
  const dow = dayOfWeek(date);
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

/** nth (1-based) occurrence of a weekday (0=Sun…6=Sat) in a month. */
function nthWeekday(year: number, month1: number, weekday: number, n: number): IsoDate {
  const first = makeIso(year, month1, 1);
  const offset = (weekday - dayOfWeek(first) + 7) % 7;
  return addDays(first, offset + (n - 1) * 7);
}

function lastWeekday(year: number, month1: number, weekday: number): IsoDate {
  const last = makeIso(year, month1 + 1, 0); // day 0 of next month = last day of this month
  const back = (dayOfWeek(last) - weekday + 7) % 7;
  return addDays(last, -back);
}

/** Western (Gregorian) Easter — Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easterSunday(year: number): IsoDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return makeIso(year, month, day);
}
