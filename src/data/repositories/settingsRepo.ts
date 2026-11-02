/**
 * Device settings (never included in backups): the market-data API key,
 * refresh preference, credit usage and last refresh time, and the price-link
 * relay address.
 *
 * Security note: a browser-only app can't hide a key from someone who has
 * your unlocked device. The key is stored only in this browser's storage and
 * sent only to the market-data provider. It's a free, read-only key, so the
 * worst case is someone using up your daily credits.
 */

import { emptyUsage, type CreditUsage } from '../../domain/market/budget';
import { getDb, S } from '../db/schema';

const K = {
  apiKey: 'marketApiKey',
  baseUrl: 'marketApiBaseUrl',
  refreshMinutes: 'refreshMinutes',
  usage: 'creditUsage',
  lastQuoteAt: 'lastQuoteAt',
  relayUrl: 'linkRelayUrl',
  feedTemplate: 'linkFeedTemplate',
  linkAttempts: 'linkAttempts',
} as const;

/** Last fetch attempt per price-linked asset (device-local; drives the 2-hour retry). */
export type LinkAttempts = Record<string, { at: number; error?: string }>;

export const DEFAULT_REFRESH_MINUTES = 10;
export const REFRESH_CHOICES = [5, 10, 15, 30] as const;

interface Row {
  key: string;
  value: unknown;
}

async function get<T>(key: string): Promise<T | undefined> {
  return ((await (await getDb()).get<Row>(S.settings, key))?.value as T | undefined) ?? undefined;
}

async function set(key: string, value: unknown): Promise<void> {
  const db = await getDb();
  await db.write([S.settings], ({ put, del }) => (value === undefined || value === '' ? del(S.settings, key) : put(S.settings, { key, value } satisfies Row)));
}

export interface MarketSettings {
  apiKey: string;
  /** Advanced: alternative API address (e.g. your own proxy). Empty = Twelve Data. */
  baseUrl: string;
  refreshMinutes: number;
}

export const settingsRepo = {
  async market(): Promise<MarketSettings> {
    const [apiKey, baseUrl, refreshMinutes] = await Promise.all([get<string>(K.apiKey), get<string>(K.baseUrl), get<number>(K.refreshMinutes)]);
    return { apiKey: apiKey ?? '', baseUrl: baseUrl ?? '', refreshMinutes: refreshMinutes ?? DEFAULT_REFRESH_MINUTES };
  },
  setApiKey: (key: string) => set(K.apiKey, key.trim()),
  setBaseUrl: (url: string) => set(K.baseUrl, url.trim().replace(/\/+$/, '')),
  setRefreshMinutes: (minutes: number) => set(K.refreshMinutes, minutes),
  async usage(): Promise<CreditUsage> {
    return (await get<CreditUsage>(K.usage)) ?? emptyUsage();
  },
  setUsage: (u: CreditUsage) => set(K.usage, u),
  lastQuoteAt: () => get<number>(K.lastQuoteAt),
  setLastQuoteAt: (ms: number) => set(K.lastQuoteAt, ms),

  async links(): Promise<{ relayUrl: string; feedTemplate: string }> {
    const [relayUrl, feedTemplate] = await Promise.all([get<string>(K.relayUrl), get<string>(K.feedTemplate)]);
    return { relayUrl: relayUrl ?? '', feedTemplate: feedTemplate ?? '' };
  },
  setRelayUrl: (url: string) => set(K.relayUrl, url.trim().replace(/\/+$/, '')),
  setFeedTemplate: (t: string) => set(K.feedTemplate, t.trim()),
  async linkAttempts(): Promise<LinkAttempts> {
    return (await get<LinkAttempts>(K.linkAttempts)) ?? {};
  },
  setLinkAttempts: (a: LinkAttempts) => set(K.linkAttempts, a),
};
