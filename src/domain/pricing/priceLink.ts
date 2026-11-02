/**
 * Price links: daily prices for funds that have no ticker (e.g. Vanguard
 * plan/trust funds) read from the fund's own web page data.
 *
 * How it works
 * ------------
 *  - You paste the fund's Vanguard page link. Only the fund number is needed
 *    (e.g. "0066" in .../profile/pe/overview/0066?...), so that's what is kept
 *    for fetching; the full link is kept only for the "Open page" button.
 *  - The app asks your relay (a free Cloudflare Worker, see relay/worker.js)
 *    for Vanguard's price data, built from a template such as
 *    https://api.vanguard.com/rs/ire/01/pe/fund/{id}/price.json
 *    Browsers don't let a web app read Vanguard's data directly (no CORS),
 *    which is why the relay exists.
 *  - The answer is parsed HERE (not in the relay), so if Vanguard changes the
 *    shape of its data the fix ships as a normal app update.
 *
 * Rules
 * -----
 *  - A price you typed yourself always wins over a fetched one on the same date.
 *  - Fetching is due when the newest stored price is older than the latest
 *    completed US trading day, at most once every RETRY_HOURS per fund
 *    (fund prices are published in the evening, New York time, so an early
 *    attempt simply retries later).
 */

import { Dec } from '../money/decimal';
import { isIsoDate, type IsoDate } from '../calendar/dates';
import type { PricePoint } from '../types';

export const DEFAULT_FEED_TEMPLATE = 'https://api.vanguard.com/rs/ire/01/pe/fund/{id}/price.json';
export const RETRY_HOURS = 2;
const ALLOWED_HOST = /(^|\.)vanguard\.com$/i;

export interface PriceLink {
  /** What the user pasted (opened by the "Open page" button). Empty when only a number was entered. */
  url: string;
  /** Vanguard's fund number, e.g. "0066". */
  fundId: string;
}

export type ParseLinkResult = { ok: true; link: PriceLink } | { ok: false; error: string };

/**
 * Accepts a Vanguard fund page link or a bare fund number.
 * The fund number is found in, by preference: the path segment after
 * "overview"/"profile", a `fundId`/`intPort` query parameter, or the last
 * all-digits path segment.
 */
export function parsePriceLink(text: string): ParseLinkResult {
  const raw = text.trim();
  if (!raw) return { ok: false, error: 'Paste the fund’s Vanguard page link.' };
  if (/^\d{2,6}$/.test(raw)) return { ok: true, link: { url: '', fundId: raw } };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That isn’t a web link. Copy the address from the fund’s Vanguard page.' };
  }
  if (u.protocol !== 'https:' || !ALLOWED_HOST.test(u.hostname)) {
    return { ok: false, error: 'Only Vanguard links (vanguard.com) are supported.' };
  }
  const segments = u.pathname.split('/').filter(Boolean);
  const afterKeyword = segments.findIndex((s) => /^(overview|profile|price)$/i.test(s));
  const candidates = [
    ...(afterKeyword >= 0 ? segments.slice(afterKeyword + 1) : []),
    u.searchParams.get('fundId') ?? u.searchParams.get('FundId') ?? '',
    u.searchParams.get('intPort') ?? '',
    ...[...segments].reverse(),
  ];
  const fundId = candidates.find((c) => /^\d{2,6}$/.test(c));
  if (!fundId) return { ok: false, error: 'Couldn’t find the fund number in that link. Open the fund’s overview page and copy its address.' };
  return { ok: true, link: { url: u.toString(), fundId } };
}

/** The data address for one fund. The template must be https and contain {id}. */
export function feedUrl(template: string, fundId: string): string {
  return (template.trim() || DEFAULT_FEED_TEMPLATE).replaceAll('{id}', encodeURIComponent(fundId));
}

export function checkFeedTemplate(template: string): string | null {
  const t = template.trim();
  if (!t) return null; // empty = default
  if (!t.includes('{id}')) return 'Include {id} where the fund number goes.';
  try {
    const u = new URL(t.replaceAll('{id}', '0'));
    if (u.protocol !== 'https:' || !ALLOWED_HOST.test(u.hostname)) return 'Must be an https://…vanguard.com address.';
  } catch {
    return 'That isn’t a valid address.';
  }
  return null;
}

/** The relay request: the relay fetches `url` for us and adds the CORS header. */
export function relayRequestUrl(relayUrl: string, target: string): string {
  return `${relayUrl.trim().replace(/\/+$/, '')}/?url=${encodeURIComponent(target)}`;
}

export interface FeedPrice {
  price: Dec;
  date: IsoDate;
}

/**
 * Finds the daily price in Vanguard's price data.
 *
 * Expected shape (as used by Vanguard's own fund page):
 *   { currentPrice: { dailyPrice: { regular: { price: "1.00", asOfDate: "2026-10-30T00:00:00-04:00" } } } }
 * Falls back to `dailyPrice.dailyMarketValue`, then to the first object
 * anywhere in the data that has both a price-like field and an as-of date —
 * so a small change in Vanguard's layout doesn't break fetching.
 */
export function parseFeedPrice(data: unknown): FeedPrice | null {
  const daily = dig(data, ['currentPrice', 'dailyPrice']) ?? dig(data, ['price', 'currentPrice', 'dailyPrice']);
  for (const key of ['regular', 'dailyMarketValue']) {
    const hit = pricePair(dig(daily, [key]));
    if (hit) return hit;
  }
  return search(data, 0);
}

function search(node: unknown, depth: number): FeedPrice | null {
  if (depth > 8 || node === null || typeof node !== 'object') return null;
  const direct = pricePair(node);
  if (direct) return direct;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = search(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function pricePair(node: unknown): FeedPrice | null {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  const o = node as Record<string, unknown>;
  const priceRaw = o.price ?? o.nav ?? o.NAV ?? o.amount;
  const dateRaw = o.asOfDate ?? o.effectiveDate ?? o.date;
  const price = toPrice(priceRaw);
  const date = toIsoDate(dateRaw);
  return price && date ? { price, date } : null;
}

function dig(node: unknown, path: readonly string[]): unknown {
  let cur = node;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** "1.00", "$1,234.56", 1 → Dec; anything not positive → null. */
export function toPrice(v: unknown): Dec | null {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    s = v.toFixed(6);
  } else if (typeof v === 'string') s = v.replace(/[$,\s]/g, '');
  else return null;
  const d = Dec.tryParse(s);
  return d && d.isPositive() ? d : null;
}

/** "2026-10-30T00:00:00-04:00", "2026-10-30", "10/30/2026" → "2026-10-30". */
export function toIsoDate(v: unknown): IsoDate | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const iso = s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && isIsoDate(iso)) return iso;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const d = `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
    return isIsoDate(d) ? d : null;
  }
  return null;
}

/** Whether a fund's price should be fetched now. */
export function linkFetchDue(newestPriceDate: IsoDate | undefined, lastAttemptMs: number | undefined, nowMs: number, latestTradingDay: IsoDate): boolean {
  if (newestPriceDate && newestPriceDate >= latestTradingDay) return false;
  return lastAttemptMs === undefined || nowMs - lastAttemptMs >= RETRY_HOURS * 3_600_000;
}

/**
 * The point to store for a fetched price, or null when nothing should change:
 * a price you typed for that date wins, and an identical fetched price isn't rewritten.
 */
export function linkPricePoint(existing: readonly PricePoint[], instrumentId: string, fetched: FeedPrice, now: string, today: IsoDate): PricePoint | null {
  if (fetched.date > today) return null; // clock/timezone oddity: never store a future price
  const same = existing.find((p) => p.instrumentId === instrumentId && p.date === fetched.date);
  if (same?.source === 'manual') return null;
  if (same && Dec.from(same.close).eq(fetched.price)) return null;
  return { instrumentId, date: fetched.date, close: fetched.price.toString(), source: 'link', updatedAt: now };
}
