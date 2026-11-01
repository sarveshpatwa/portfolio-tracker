/**
 * The market-data provider interface. The rest of the app only talks to this,
 * so swapping Twelve Data for another source (Finnhub, Alpha Vantage, a
 * proxy) means writing one new adapter file — no screen or calculation changes.
 */

import type { Dec } from '../../domain/money/decimal';
import type { IsoDate } from '../../domain/calendar/dates';
import type { AssetClass } from '../../domain/types';

export interface SymbolMatch {
  symbol: string;
  name: string;
  exchange: string;
  type: string; // provider's label, e.g. "ETF", "Common Stock"
  assetClass: AssetClass; // our best guess from `type`; the user can change it
  country: string;
  currency: string;
}

export interface Quote {
  symbol: string;
  /** Latest trade price during the session, the closing price after it. */
  price: Dec;
  previousClose?: Dec;
  /** Trading date the price belongs to (New York). */
  date: IsoDate;
  /** When the price was observed (ms since epoch). */
  observedAt: number;
  marketOpen: boolean;
  currency: string;
  name?: string;
}

export interface DailyBar {
  date: IsoDate;
  close: Dec;
}

export type ProviderErrorKind =
  | 'no-key'
  | 'auth'
  | 'plan'
  | 'not-found'
  | 'rate-limit'
  | 'bad-request'
  | 'network'
  | 'server'
  | 'bad-response';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface MarketDataProvider {
  readonly name: string;
  /** Credits each call costs (for the rate limiter). */
  readonly cost: { search: number; quotePerSymbol: number; historyPerSymbol: number };
  search(query: string): Promise<SymbolMatch[]>;
  /** Quotes for several symbols; symbols that failed are reported separately. */
  quotes(symbols: readonly string[]): Promise<{ quotes: Map<string, Quote>; errors: Map<string, ProviderError> }>;
  /** Daily closes, oldest first. `startDate` omitted = as much history as available. */
  dailyHistory(symbol: string, startDate?: IsoDate): Promise<DailyBar[]>;
}
