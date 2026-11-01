import type { DatedPrice } from '../../domain/pricing/prices';
import { parseIso, type IsoDate } from '../../domain/calendar/dates';

const etTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const shortDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/** "2:42 PM ET" */
export function formatEt(at: string | number): string {
  return `${etTime.format(new Date(at))} ET`;
}

/** "Oct 30" for a trading date. */
export function formatTradingDate(date: IsoDate): string {
  return shortDate.format(parseIso(date));
}

/** "Live · 2:42 PM ET" during the session, otherwise "Close · Oct 30". */
export function marketPriceLabel(p: Pick<DatedPrice, 'intraday' | 'updatedAt' | 'date'>): string {
  if (p.intraday) return p.updatedAt ? `Live · ${formatEt(p.updatedAt)}` : `Live · ${formatTradingDate(p.date)}`;
  return `Close · ${formatTradingDate(p.date)}`;
}
