/**
 * Twelve Data adapter (https://twelvedata.com, free "Basic" plan).
 *
 * Endpoints used (1 credit per symbol / per search):
 *   GET /symbol_search?symbol=…           find tickers
 *   GET /quote?symbol=A,B,C               latest price, previous close, market-open flag
 *   GET /time_series?symbol=…&interval=1day&outputsize=5000 | &start_date=…   daily closes
 *
 * The key is sent as the `apikey` query parameter. (An Authorization header
 * would make the browser send an extra "preflight" request first.) Errors come
 * back as JSON `{ code, message, status: "error" }` and are translated into
 * plain-language ProviderErrors.
 *
 * The parsers are exported separately so they can be tested with sample
 * responses, without network access.
 */

import { Dec } from '../../domain/money/decimal';
import { isIsoDate } from '../../domain/calendar/dates';
import type { AssetClass } from '../../domain/types';
import { ProviderError, type DailyBar, type MarketDataProvider, type Quote, type SymbolMatch } from './marketData';

type Json = Record<string, unknown>;
type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const TWELVE_DATA_BASE_URL = 'https://api.twelvedata.com';

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = 'Twelve Data';
  readonly cost = { search: 1, quotePerSymbol: 1, historyPerSymbol: 1 };

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = (url) => fetch(url),
    private readonly baseUrl: string = TWELVE_DATA_BASE_URL,
  ) {}

  async search(query: string): Promise<SymbolMatch[]> {
    const json = await this.get('/symbol_search', { symbol: query.trim(), outputsize: '30' });
    return parseSearch(json);
  }

  async quotes(symbols: readonly string[]) {
    if (symbols.length === 0) return { quotes: new Map<string, Quote>(), errors: new Map<string, ProviderError>() };
    const json = await this.get('/quote', { symbol: symbols.join(',') });
    return parseQuotes(json, symbols);
  }

  async dailyHistory(symbol: string, startDate?: string): Promise<DailyBar[]> {
    const params: Record<string, string> = { symbol, interval: '1day', order: 'asc' };
    if (startDate) params.start_date = startDate;
    else params.outputsize = '5000';
    try {
      return parseTimeSeries(await this.get('/time_series', params));
    } catch (err) {
      // Asking for days that have no data yet (e.g. a top-up on a holiday) is not an error.
      if (startDate && err instanceof ProviderError && err.kind === 'bad-request' && /no data/i.test(err.message)) return [];
      throw err;
    }
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    if (!this.apiKey) throw new ProviderError('no-key', 'Add your Twelve Data API key in Settings to get live prices.');
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('apikey', this.apiKey);

    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(url.toString());
    } catch {
      throw new ProviderError(
        'network',
        'Couldn’t reach Twelve Data. Check your internet connection. If you are online, the browser may have blocked the request.',
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError(res.status >= 500 ? 'server' : 'bad-response', `Twelve Data sent an unreadable response (HTTP ${res.status}).`);
    }
    const err = errorFrom(json, res.status);
    if (err) throw err;
    return json;
  }
}

// --- Parsers ---------------------------------------------------------------

/** Converts a Twelve Data error body (or HTTP status) into a ProviderError, or null if it's not an error. */
export function errorFrom(json: unknown, httpStatus = 200): ProviderError | null {
  const body = isObj(json) ? json : {};
  const isError = body.status === 'error' || httpStatus >= 400;
  if (!isError) return null;
  const code = typeof body.code === 'number' ? body.code : httpStatus;
  const detail = typeof body.message === 'string' ? body.message : '';
  switch (code) {
    case 401:
      return new ProviderError('auth', 'Twelve Data didn’t accept the API key. Check it in Settings.');
    case 403:
      return new ProviderError('plan', `This needs a paid Twelve Data plan. ${detail}`.trim());
    case 404:
      return new ProviderError('not-found', 'Twelve Data has no data for this symbol.');
    case 429:
      return new ProviderError('rate-limit', 'The free plan’s limit was reached (8 per minute, 800 per day). Prices will refresh when allowed.', 60_000);
    case 400:
    case 414:
      return new ProviderError('bad-request', detail || 'Twelve Data rejected the request.');
    default:
      return code >= 500
        ? new ProviderError('server', 'Twelve Data is having problems right now. Prices will retry later.')
        : new ProviderError('bad-response', detail || `Unexpected response from Twelve Data (code ${code}).`);
  }
}

export function parseSearch(json: unknown): SymbolMatch[] {
  if (!isObj(json) || !Array.isArray(json.data)) throw new ProviderError('bad-response', 'Unexpected search response from Twelve Data.');
  const out: SymbolMatch[] = [];
  const seen = new Set<string>();
  for (const row of json.data) {
    if (!isObj(row) || typeof row.symbol !== 'string') continue;
    if (row.country !== 'United States') continue; // US-listed only (free plan, and your requirement)
    const symbol = row.symbol.toUpperCase();
    if (seen.has(symbol)) continue; // the same ticker can be listed on several venues
    seen.add(symbol);
    const type = str(row.instrument_type);
    out.push({
      symbol,
      name: str(row.instrument_name) || symbol,
      exchange: str(row.exchange),
      type,
      assetClass: assetClassFor(type, str(row.instrument_name)),
      country: str(row.country),
      currency: str(row.currency) || 'USD',
    });
  }
  return out;
}

export function assetClassFor(type: string, name = ''): AssetClass {
  const t = type.toLowerCase();
  if (t.includes('etf')) return /\b(bond|treasury|aggregate|fixed income|muni)\b/i.test(name) ? 'bond' : 'etf';
  if (t.includes('mutual fund')) return 'fund';
  if (t.includes('bond')) return 'bond';
  if (t.includes('stock') || t.includes('depositary') || t.includes('reit')) return 'stock';
  return 'other';
}

/**
 * /quote returns one object for a single symbol, or an object keyed by symbol
 * for several — where any entry may itself be an error.
 */
export function parseQuotes(json: unknown, requested: readonly string[]) {
  const quotes = new Map<string, Quote>();
  const errors = new Map<string, ProviderError>();
  const entries: [string, unknown][] =
    requested.length === 1 ? [[requested[0]!, json]] : requested.map((s) => [s, isObj(json) ? json[s] ?? json[s.toUpperCase()] : undefined]);
  for (const [symbol, body] of entries) {
    const err = body === undefined ? new ProviderError('not-found', `No quote returned for ${symbol}.`) : errorFrom(body);
    if (err) {
      errors.set(symbol, err);
      continue;
    }
    try {
      quotes.set(symbol, parseQuote(body, symbol));
    } catch (e) {
      errors.set(symbol, e instanceof ProviderError ? e : new ProviderError('bad-response', `Unreadable quote for ${symbol}.`));
    }
  }
  return { quotes, errors };
}

function parseQuote(body: unknown, symbol: string): Quote {
  if (!isObj(body)) throw new ProviderError('bad-response', `Unreadable quote for ${symbol}.`);
  const price = Dec.tryParse(str(body.close));
  const date = str(body.datetime).slice(0, 10);
  if (!price || !price.isPositive() || !isIsoDate(date)) throw new ProviderError('bad-response', `Unreadable quote for ${symbol}.`);
  const prev = Dec.tryParse(str(body.previous_close));
  const seconds = typeof body.last_quote_at === 'number' ? body.last_quote_at : typeof body.timestamp === 'number' ? body.timestamp : NaN;
  return {
    symbol,
    price,
    ...(prev && prev.isPositive() ? { previousClose: prev } : {}),
    date,
    observedAt: Number.isFinite(seconds) ? seconds * 1000 : Date.now(),
    marketOpen: body.is_market_open === true,
    currency: str(body.currency) || 'USD',
    ...(typeof body.name === 'string' ? { name: body.name } : {}),
  };
}

export function parseTimeSeries(json: unknown): DailyBar[] {
  if (!isObj(json) || !Array.isArray(json.values)) throw new ProviderError('bad-response', 'Unexpected history response from Twelve Data.');
  const bars: DailyBar[] = [];
  for (const v of json.values) {
    if (!isObj(v)) continue;
    const date = str(v.datetime).slice(0, 10);
    const close = Dec.tryParse(str(v.close));
    if (isIsoDate(date) && close && close.isPositive()) bars.push({ date, close });
  }
  return bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
