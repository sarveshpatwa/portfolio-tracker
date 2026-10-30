/**
 * Calendar dates as ISO strings ("2026-09-15").
 *
 * Trading happens on calendar days in New York, so the app never needs
 * time-of-day or time zones for dates: a plain YYYY-MM-DD string sorts
 * correctly, compares with < and >, and stores cleanly. All arithmetic
 * below runs in UTC so the device's time zone (India, US, ...) can't shift a
 * date by one day.
 */

export type IsoDate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return toIso(date) === value;
}

export function parseIso(value: IsoDate): Date {
  if (!isIsoDate(value)) throw new RangeError(`Invalid ISO date: "${value}"`);
  const [y, mo, da] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, da));
}

export function toIso(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function makeIso(year: number, month1: number, day: number): IsoDate {
  return toIso(new Date(Date.UTC(year, month1 - 1, day)));
}

export function addDays(value: IsoDate, days: number): IsoDate {
  const date = parseIso(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
}

/**
 * Adds calendar months, clamping to the month's last day:
 * Jan 31 + 1 month = Feb 28 (or 29). Callers that repeat monthly should
 * always add n months to the ORIGINAL start date, not chain additions, or
 * the 31st would drift to the 28th forever.
 */
export function addMonths(value: IsoDate, months: number): IsoDate {
  const date = parseIso(value);
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1);
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(value: IsoDate): number {
  return parseIso(value).getUTCDay();
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / 86_400_000);
}

/** Today's date on this device's own calendar (for dates the user types, e.g. a manual price). */
export function todayLocal(now: Date = new Date()): IsoDate {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today's date in New York (the market's calendar), regardless of device time zone. */
export function todayInNewYork(now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
