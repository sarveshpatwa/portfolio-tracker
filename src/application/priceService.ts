/**
 * Price service — keeps market prices fresh without exceeding the free plan.
 *
 * What it does, and when (checked once a minute while the app is open and
 * visible, plus whenever the app comes back to the foreground or online):
 *
 *  1. History catch-up (any time): for every ticker in use, download the daily
 *     closes it's missing — full history the first time, then only the gap
 *     (see domain/market/history.ts). 1 credit per ticker that needs it.
 *  2. Live quotes (market hours only): every N minutes, where N is your
 *     preferred interval, stretched automatically if you hold many tickers
 *     (domain/market/budget.ts). 1 credit per ticker, in batches of ≤ 8 per
 *     minute. The quote is stored as TODAY's price point (marked intraday)
 *     and becomes the final close after the session.
 *
 * iPhone note: iOS pauses web apps in the background, so prices only refresh
 * while the app is open. Nothing is lost — the next open catches up.
 *
 * Every request first asks the credit limiter; if the minute or day budget is
 * used up, the service waits (minute) or stops until midnight UTC (day).
 */

import { Dec } from '../domain/money/decimal';
import { checkCredits, chunk, creditsUsedToday, effectiveRefreshMinutes, FREE_PLAN, type CreditUsage } from '../domain/market/budget';
import { historyRequest } from '../domain/market/history';
import { closeIsFinal, latestCompletedTradingDay, marketSession, type Session } from '../domain/market/marketHours';
import type { Instrument, PortfolioAsset, PricePoint } from '../domain/types';
import { spendCredits } from '../domain/market/budget';
import { assetRepo, priceRepo } from '../data/repositories/assetRepo';
import { settingsRepo, type MarketSettings } from '../data/repositories/settingsRepo';
import { ProviderError, type DailyBar, type MarketDataProvider, type Quote, type SymbolMatch } from '../data/providers/marketData';
import { TwelveDataProvider } from '../data/providers/twelveData';

export interface PriceStatus {
  state: 'idle' | 'refreshing' | 'no-key' | 'error' | 'waiting';
  message?: string;
  lastQuoteAt?: number;
  creditsToday: number;
  creditLimit: number;
  intervalMinutes: number;
  intervalLimited: boolean;
  session: Session;
  symbols: number;
}

type Listener = (s: PriceStatus) => void;

/** Creates the provider from settings. Replaceable in tests. */
export let makeProvider = (s: MarketSettings): MarketDataProvider =>
  new TwelveDataProvider(s.apiKey, undefined, s.baseUrl || undefined);
export function setProviderFactory(f: typeof makeProvider): void {
  makeProvider = f;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PriceService {
  private status: PriceStatus = {
    state: 'idle',
    creditsToday: 0,
    creditLimit: FREE_PLAN.perDay,
    intervalMinutes: 10,
    intervalLimited: false,
    session: 'closed-day',
    symbols: 0,
  };
  private listeners = new Set<Listener>();
  private busy: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private searchCache = new Map<string, SymbolMatch[]>();
  /**
   * Trading day + set of tickers at the last successful history check, so it
   * runs once per day — and again as soon as tickers are added (e.g. by a restore).
   */
  private historyCheckedFor = '';

  // --- status ---------------------------------------------------------------
  getStatus = (): PriceStatus => this.status;
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private setStatus(patch: Partial<PriceStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  // --- lifecycle --------------------------------------------------------------
  start(): void {
    if (this.timer) return;
    const kick = () => void this.tick();
    this.timer = setInterval(kick, 60_000);
    document.addEventListener('visibilitychange', () => !document.hidden && kick());
    window.addEventListener('online', kick);
    kick();
  }

  /** Called by settings/asset changes so status and schedule update immediately. */
  async tick(opts: { forceQuotes?: boolean } = {}): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.run(opts).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  // --- the work ---------------------------------------------------------------
  private async run({ forceQuotes = false }: { forceQuotes?: boolean }): Promise<void> {
    const now = new Date();
    const settings = await settingsRepo.market();
    const instruments = await this.marketInstrumentsInUse();
    const { minutes, limited } = effectiveRefreshMinutes(instruments.length, settings.refreshMinutes);
    const usage = await settingsRepo.usage();
    const lastQuoteAt = await settingsRepo.lastQuoteAt();
    const session = marketSession(now);
    this.setStatus({
      session,
      symbols: instruments.length,
      intervalMinutes: minutes,
      intervalLimited: limited,
      creditsToday: creditsUsedToday(usage, now.getTime()),
      ...(lastQuoteAt ? { lastQuoteAt } : {}),
    });

    if (!settings.apiKey) return this.setStatus({ state: 'no-key', message: 'Add your Twelve Data API key in Settings to get live prices.' });
    if (instruments.length === 0) return this.setStatus({ state: 'idle', message: undefined });
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return this.setStatus({ state: 'error', message: 'Offline — showing the last saved prices.' });
    }
    if (typeof document !== 'undefined' && document.hidden && !forceQuotes) return;

    const provider = makeProvider(settings);
    this.setStatus({ state: 'refreshing', message: undefined });
    try {
      const historyKey = `${latestCompletedTradingDay(now)}|${instruments.map((i) => i.id).sort().join(',')}`;
      if (this.historyCheckedFor !== historyKey || forceQuotes) {
        await this.catchUpHistory(provider, instruments, now);
        this.historyCheckedFor = historyKey;
      }
      const due = !lastQuoteAt || now.getTime() - lastQuoteAt >= minutes * 60_000;
      const failures = forceQuotes || (session === 'open' && due) ? await this.refreshQuotes(provider, instruments) : [];
      this.setStatus({ state: failures.length ? 'error' : 'idle', message: failures.length ? failures.join(' ') : undefined });
    } catch (err) {
      this.setStatus(errorStatus(err));
    }
  }

  private async marketInstrumentsInUse(): Promise<Instrument[]> {
    const [links, instruments] = await Promise.all([assetRepo.listAllLinks(), assetRepo.listInstruments()]);
    const used = new Set(links.map((l: PortfolioAsset) => l.instrumentId));
    return instruments.filter((i) => i.priceSource === 'market' && i.symbol && used.has(i.id));
  }

  private async catchUpHistory(provider: MarketDataProvider, instruments: readonly Instrument[], now: Date) {
    const latest = latestCompletedTradingDay(now);
    const all = await priceRepo.listAll();
    for (const inst of instruments) {
      const req = historyRequest(
        all.filter((p) => p.instrumentId === inst.id),
        latest,
      );
      if (!req) continue;
      await this.spend(provider.cost.historyPerSymbol);
      const bars = await provider.dailyHistory(inst.symbol!, req.kind === 'since' ? req.startDate : undefined);
      await priceRepo.putMany(barsToPoints(inst.id, bars));
    }
  }

  /** Returns per-ticker problems (e.g. "XYZ: no data") — other tickers still update. */
  private async refreshQuotes(provider: MarketDataProvider, instruments: readonly Instrument[]): Promise<string[]> {
    const bySymbol = new Map(instruments.map((i) => [i.symbol!, i]));
    const failures: string[] = [];
    for (const batch of chunk([...bySymbol.keys()], FREE_PLAN.perMinute)) {
      await this.spend(batch.length * provider.cost.quotePerSymbol);
      const { quotes, errors } = await provider.quotes(batch);
      const now = new Date();
      await priceRepo.putMany([...quotes.values()].map((q) => quoteToPoint(bySymbol.get(q.symbol)!.id, q, now)));
      for (const [sym, e] of errors) failures.push(`${sym}: ${e.message}`);
    }
    const at = Date.now();
    await settingsRepo.setLastQuoteAt(at);
    this.setStatus({ lastQuoteAt: at });
    return failures;
  }

  /** Waits for the per-minute window if needed; throws if today's credits are used up. */
  private async spend(credits: number): Promise<void> {
    for (;;) {
      const usage = await settingsRepo.usage();
      const now = Date.now();
      const check = checkCredits(usage, credits, now);
      if (check.ok) {
        const next: CreditUsage = spendCredits(usage, credits, now);
        await settingsRepo.setUsage(next);
        this.setStatus({ creditsToday: next.used });
        return;
      }
      if (check.reason === 'day') {
        throw new ProviderError('rate-limit', 'Today’s 800 free credits are used up. Prices resume after midnight UTC (5:30 am in India).');
      }
      this.setStatus({ state: 'waiting', message: `Free-plan limit: continuing in ${Math.ceil(check.waitMs / 1000)} s…` });
      await sleep(check.waitMs + 250);
      this.setStatus({ state: 'refreshing', message: undefined });
    }
  }

  // --- on-demand calls used by the Add asset screen --------------------------
  async search(query: string): Promise<SymbolMatch[]> {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const cached = this.searchCache.get(q);
    if (cached) return cached;
    const provider = makeProvider(await settingsRepo.market());
    await this.spend(provider.cost.search);
    const results = await provider.search(q);
    this.searchCache.set(q, results);
    return results;
  }

  async quote(symbol: string): Promise<Quote> {
    const provider = makeProvider(await settingsRepo.market());
    await this.spend(provider.cost.quotePerSymbol);
    const { quotes, errors } = await provider.quotes([symbol]);
    const q = quotes.get(symbol);
    if (!q) throw errors.get(symbol) ?? new ProviderError('not-found', `No price for ${symbol}.`);
    return q;
  }

  /**
   * Daily history for a ticker being added. Reuses stored history when another
   * portfolio already holds it (`fresh: false`, nothing to save); otherwise
   * downloads it (1 credit, `fresh: true`).
   */
  async historyFor(symbol: string): Promise<{ points: Omit<PricePoint, 'instrumentId'>[]; fresh: boolean }> {
    const existing = await assetRepo.findMarketInstrument(symbol);
    if (existing) {
      const stored = await priceRepo.listForInstrument(existing.id);
      if (stored.some((p) => p.source === 'market' && !p.intraday)) return { points: stored, fresh: false };
    }
    const provider = makeProvider(await settingsRepo.market());
    await this.spend(provider.cost.historyPerSymbol);
    const points = barsToPoints('', await provider.dailyHistory(symbol)).map(({ instrumentId: _id, ...rest }) => rest);
    return { points, fresh: true };
  }

  /** Checks a key with one cheap request (1 credit). */
  async testKey(apiKey: string, baseUrl: string): Promise<Quote> {
    const provider = makeProvider({ apiKey, baseUrl, refreshMinutes: 10 });
    await this.spend(provider.cost.quotePerSymbol);
    const { quotes, errors } = await provider.quotes(['SPY']);
    const q = quotes.get('SPY');
    if (!q) throw errors.get('SPY') ?? new ProviderError('bad-response', 'No answer from the provider.');
    return q;
  }
}

function barsToPoints(instrumentId: string, bars: readonly DailyBar[]): PricePoint[] {
  const updatedAt = new Date().toISOString();
  return bars.map((b) => ({ instrumentId, date: b.date, close: b.close.toString(), source: 'market', updatedAt }));
}

/** A quote becomes the price point for its trading day; intraday until that day's close is final. */
export function quoteToPoint(instrumentId: string, q: Quote, now: Date): PricePoint {
  const final = closeIsFinal(now, q.date) && !q.marketOpen;
  return {
    instrumentId,
    date: q.date,
    close: Dec.from(q.price).toString(),
    source: 'market',
    updatedAt: new Date(q.observedAt || now.getTime()).toISOString(),
    ...(final ? {} : { intraday: true }),
  };
}

function errorStatus(err: unknown): Partial<PriceStatus> {
  if (err instanceof ProviderError) return { state: err.kind === 'rate-limit' ? 'waiting' : 'error', message: err.message };
  return { state: 'error', message: err instanceof Error ? err.message : 'Price refresh failed.' };
}

export const priceService = new PriceService();
