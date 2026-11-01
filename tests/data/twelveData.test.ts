import { describe, expect, it } from 'vitest';
import { assetClassFor, errorFrom, parseQuotes, parseSearch, parseTimeSeries, TwelveDataProvider } from '../../src/data/providers/twelveData';
import { ProviderError } from '../../src/data/providers/marketData';

// Sample responses shaped like Twelve Data's documented JSON.
const quoteVTI = {
  symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', exchange: 'NYSE', mic_code: 'ARCX', currency: 'USD',
  datetime: '2026-10-30', timestamp: 1793367000, last_quote_at: 1793384100, open: '291.10', high: '293.40', low: '290.80',
  close: '292.91', volume: '3120000', previous_close: '290.55', change: '2.36', percent_change: '0.81', is_market_open: true,
};

describe('parseQuotes', () => {
  it('reads a single-symbol response', () => {
    const { quotes, errors } = parseQuotes(quoteVTI, ['VTI']);
    const q = quotes.get('VTI');
    expect(errors.size).toBe(0);
    expect(q?.price.toString()).toBe('292.91');
    expect(q?.previousClose?.toString()).toBe('290.55');
    expect(q?.date).toBe('2026-10-30');
    expect(q?.marketOpen).toBe(true);
    expect(q?.observedAt).toBe(1793384100 * 1000);
  });

  it('reads a multi-symbol response with one failing symbol', () => {
    const json = {
      VTI: quoteVTI,
      BND: { ...quoteVTI, symbol: 'BND', close: '73.00', is_market_open: false },
      NOPE: { code: 404, message: 'symbol not found', status: 'error' },
    };
    const { quotes, errors } = parseQuotes(json, ['VTI', 'BND', 'NOPE']);
    expect([...quotes.keys()]).toEqual(['VTI', 'BND']);
    expect(quotes.get('BND')?.marketOpen).toBe(false);
    expect(errors.get('NOPE')?.kind).toBe('not-found');
  });

  it('rejects unreadable prices instead of storing nonsense', () => {
    const { quotes, errors } = parseQuotes({ ...quoteVTI, close: 'N/A' }, ['VTI']);
    expect(quotes.size).toBe(0);
    expect(errors.get('VTI')?.kind).toBe('bad-response');
  });
});

describe('parseTimeSeries', () => {
  it('returns daily closes oldest first', () => {
    const json = {
      meta: { symbol: 'VTI', interval: '1day', currency: 'USD', exchange_timezone: 'America/New_York', exchange: 'NYSE', type: 'ETF' },
      values: [
        { datetime: '2026-10-30', open: '1', high: '1', low: '1', close: '292.91', volume: '1' },
        { datetime: '2026-10-29', open: '1', high: '1', low: '1', close: '290.55', volume: '1' },
        { datetime: 'garbage', close: 'x' },
      ],
      status: 'ok',
    };
    expect(parseTimeSeries(json).map((b) => [b.date, b.close.toString()])).toEqual([
      ['2026-10-29', '290.55'],
      ['2026-10-30', '292.91'],
    ]);
  });
});

describe('parseSearch', () => {
  it('keeps US listings only, once per ticker, with a guessed asset class', () => {
    const json = {
      data: [
        { symbol: 'VTI', instrument_name: 'Vanguard Total Stock Market ETF', exchange: 'NYSE', mic_code: 'ARCX', instrument_type: 'ETF', country: 'United States', currency: 'USD' },
        { symbol: 'VTI', instrument_name: 'Vanguard Total Stock Market ETF', exchange: 'BATS', instrument_type: 'ETF', country: 'United States', currency: 'USD' },
        { symbol: 'VTI', instrument_name: 'Vanguard Total Stock Market ETF', exchange: 'MEX', instrument_type: 'ETF', country: 'Mexico', currency: 'MXN' },
        { symbol: 'BND', instrument_name: 'Vanguard Total Bond Market ETF', exchange: 'NASDAQ', instrument_type: 'ETF', country: 'United States', currency: 'USD' },
        { symbol: 'AAPL', instrument_name: 'Apple Inc', exchange: 'NASDAQ', instrument_type: 'Common Stock', country: 'United States', currency: 'USD' },
      ],
      status: 'ok',
    };
    expect(parseSearch(json).map((m) => [m.symbol, m.exchange, m.assetClass])).toEqual([
      ['VTI', 'NYSE', 'etf'],
      ['BND', 'NASDAQ', 'bond'],
      ['AAPL', 'NASDAQ', 'stock'],
    ]);
  });

  it('guesses asset classes', () => {
    expect(assetClassFor('Mutual Fund')).toBe('fund');
    expect(assetClassFor('ETF', 'iShares 20+ Year Treasury Bond ETF')).toBe('bond');
    expect(assetClassFor('American Depositary Receipt')).toBe('stock');
    expect(assetClassFor('Warrant')).toBe('other');
  });
});

describe('errors', () => {
  it('maps Twelve Data error codes to plain language', () => {
    expect(errorFrom({ code: 401, message: 'apikey incorrect', status: 'error' })?.kind).toBe('auth');
    expect(errorFrom({ code: 429, message: 'run out of API credits', status: 'error' })?.retryAfterMs).toBe(60_000);
    expect(errorFrom({ code: 403, message: 'available starting with Grow', status: 'error' })?.message).toContain('paid Twelve Data plan');
    expect(errorFrom({}, 503)?.kind).toBe('server');
    expect(errorFrom({ status: 'ok' })).toBeNull();
  });
});

describe('TwelveDataProvider requests', () => {
  const fakeFetch = (body: unknown, status = 200) => {
    const calls: string[] = [];
    const fn = async (url: string) => {
      calls.push(url);
      return { ok: status < 400, status, json: async () => body };
    };
    return { fn, calls };
  };

  it('batches symbols into one quote request with the key as a query parameter', async () => {
    const { fn, calls } = fakeFetch({ VTI: quoteVTI, BND: { ...quoteVTI, close: '73' } });
    const p = new TwelveDataProvider('KEY123', fn, 'https://api.example');
    const { quotes } = await p.quotes(['VTI', 'BND']);
    expect(quotes.size).toBe(2);
    expect(calls).toEqual(['https://api.example/quote?symbol=VTI%2CBND&apikey=KEY123']);
  });

  it('asks for full history, or only since a date', async () => {
    const { fn, calls } = fakeFetch({ values: [], status: 'ok' });
    const p = new TwelveDataProvider('K', fn, 'https://api.example');
    await p.dailyHistory('VTI');
    await p.dailyHistory('VTI', '2026-10-29');
    expect(calls[0]).toContain('outputsize=5000');
    expect(calls[1]).toContain('start_date=2026-10-29');
    expect(calls[1]).not.toContain('outputsize');
  });

  it('treats "no data" for a top-up as an empty result', async () => {
    const { fn } = fakeFetch({ code: 400, message: 'No data is available on the specified dates', status: 'error' });
    expect(await new TwelveDataProvider('K', fn).dailyHistory('VTI', '2026-10-31')).toEqual([]);
  });

  it('reports a missing key, bad key and network failure clearly', async () => {
    await expect(new TwelveDataProvider('', fakeFetch({}).fn).search('VTI')).rejects.toMatchObject({ kind: 'no-key' });
    await expect(new TwelveDataProvider('bad', fakeFetch({ code: 401, message: 'x', status: 'error' }, 401).fn).search('VTI')).rejects.toMatchObject({ kind: 'auth' });
    const offline = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(new TwelveDataProvider('K', offline).quotes(['VTI'])).rejects.toBeInstanceOf(ProviderError);
  });
});
