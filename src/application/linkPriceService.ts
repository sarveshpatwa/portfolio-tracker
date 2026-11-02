/**
 * Price links: fetches the daily price of every manual asset that has a
 * Vanguard link, through your relay. Runs after each price-service tick
 * (app start, once a minute, returning to the app) but only fetches a fund
 * when its newest price is older than the last completed trading day, and
 * then at most once every 2 hours (see domain/pricing/priceLink.ts).
 *
 * Funds are fetched one after another (not in parallel) to stay polite.
 */

import { latestCompletedTradingDay } from '../domain/market/marketHours';
import { todayInNewYork } from '../domain/calendar/dates';
import { linkFetchDue, linkPricePoint, type FeedPrice } from '../domain/pricing/priceLink';
import type { Id, Instrument } from '../domain/types';
import { assetRepo, priceRepo } from '../data/repositories/assetRepo';
import { settingsRepo, type LinkAttempts } from '../data/repositories/settingsRepo';
import { fetchLinkPrice, LinkFetchError, type FetchFn } from '../data/providers/linkPrice';

type Listener = () => void;

export interface LinkState {
  fetching: boolean;
  lastAttemptAt?: number;
  error?: string;
  relaySet: boolean;
}

class LinkPriceService {
  private attempts: LinkAttempts = {};
  private fetching = new Set<Id>();
  private relaySet = false;
  private listeners = new Set<Listener>();
  private version = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private fetchFn: FetchFn | undefined;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;
  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  stateOf(instrumentId: Id): LinkState {
    const a = this.attempts[instrumentId];
    return {
      fetching: this.fetching.has(instrumentId),
      relaySet: this.relaySet,
      ...(a ? { lastAttemptAt: a.at } : {}),
      ...(a?.error ? { error: a.error } : {}),
    };
  }

  /** Test hook: replace the network call. */
  setFetch(fn: FetchFn | undefined) {
    this.fetchFn = fn;
  }

  /**
   * Fetches every due fund. `force` fetches now regardless of the schedule
   * (all funds, or only `only`). Returns how many prices were saved.
   */
  runDue(opts: { force?: boolean; only?: Id } = {}, now = new Date()): Promise<number> {
    const run = this.queue.then(() => this.doRun(opts, now));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doRun(opts: { force?: boolean; only?: Id }, now: Date): Promise<number> {
    const linked = (await assetRepo.listInstruments()).filter((i): i is Instrument & { priceLink: NonNullable<Instrument['priceLink']> } => !!i.priceLink);
    const settings = await settingsRepo.links();
    this.attempts = await settingsRepo.linkAttempts();
    const relayWasSet = this.relaySet;
    this.relaySet = !!settings.relayUrl;
    if (linked.length === 0 || !settings.relayUrl) {
      if (relayWasSet !== this.relaySet) this.emit();
      return 0;
    }

    const latest = latestCompletedTradingDay(now);
    const today = todayInNewYork(now);
    let saved = 0;
    let changed = relayWasSet !== this.relaySet;
    for (const inst of linked) {
      const points = await priceRepo.listForInstrument(inst.id);
      const newest = points.reduce<string | undefined>((m, p) => (!m || p.date > m ? p.date : m), undefined);
      const forced = opts.force && (!opts.only || opts.only === inst.id);
      if (!forced && !linkFetchDue(newest, this.attempts[inst.id]?.at, now.getTime(), latest)) continue;

      this.fetching.add(inst.id);
      this.emit();
      changed = true;
      try {
        const price: FeedPrice = await fetchLinkPrice(settings.relayUrl, settings.feedTemplate, inst.priceLink.fundId, this.fetchFn);
        const point = linkPricePoint(points, inst.id, price, now.toISOString(), today);
        if (point) {
          await priceRepo.putMany([point]);
          saved++;
        }
        this.attempts[inst.id] = { at: now.getTime() };
      } catch (err) {
        if (err instanceof LinkFetchError && err.kind === 'offline') {
          // Not an attempt: try again as soon as the device is back online.
        } else {
          this.attempts[inst.id] = { at: now.getTime(), error: err instanceof Error ? err.message : 'Couldn’t fetch the price.' };
        }
      } finally {
        this.fetching.delete(inst.id);
      }
    }
    // Forget attempts for assets that no longer have a link.
    for (const id of Object.keys(this.attempts)) if (!linked.some((i) => i.id === id)) delete this.attempts[id];
    await settingsRepo.setLinkAttempts(this.attempts);
    if (changed) this.emit();
    return saved;
  }

  /** Settings → "Test": fetch one fund with the given (unsaved) settings. */
  test(relayUrl: string, template: string, fundId: string): Promise<FeedPrice> {
    return fetchLinkPrice(relayUrl, template, fundId, this.fetchFn);
  }
}

export const linkPriceService = new LinkPriceService();
