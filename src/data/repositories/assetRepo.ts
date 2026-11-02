/**
 * Assets inside portfolios, manual prices, and opening positions.
 *
 * Adding a manual asset writes, in ONE atomic transaction:
 *   1. the Instrument (shared definition: name, class, price source),
 *   2. the PortfolioAsset link,
 *   3. its price point(s),
 *   4. an OPENING ledger entry when a starting position was entered.
 * So a failure halfway can never leave a half-created asset.
 */

import type { ManualAssetValues } from '../../domain/assets/manualAssetForm';
import { holdingUpdateRecords, type HoldingUpdate } from '../../domain/assets/holdingUpdate';
import { LedgerError, replayLedger } from '../../domain/portfolio/ledger';
import { planAssetDeletion, type AssetDeletionPlan } from '../../domain/assets/deleteAsset';
import type { MarketStart } from '../../domain/assets/marketAssetForm';
import type { Deletion, Instrument, PortfolioAsset, PricePoint, Transaction } from '../../domain/types';
import { getDb, S } from '../db/schema';
import { newId, nextSeq } from '../ids';
import { ValidationError } from './errors';
import type { PriceLink } from '../../domain/pricing/priceLink';
import { groupKey } from '../../domain/pricing/fundGroups';

export const assetRepo = {
  async listForPortfolio(portfolioId: string): Promise<PortfolioAsset[]> {
    const db = await getDb();
    const rows = await db.getAllByIndex<PortfolioAsset>(S.portfolioAssets, 'portfolioId', portfolioId);
    return rows.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  },

  async listAllLinks(): Promise<PortfolioAsset[]> {
    return (await getDb()).getAll<PortfolioAsset>(S.portfolioAssets);
  },

  async listInstruments(): Promise<Instrument[]> {
    return (await getDb()).getAll<Instrument>(S.instruments);
  },

  async addManualAsset(portfolioId: string, v: ManualAssetValues): Promise<PortfolioAsset> {
    const db = await getDb();
    const now = new Date().toISOString();
    const instrument: Instrument = {
      id: newId(),
      name: v.name,
      assetClass: v.assetClass,
      priceSource: 'manual',
      currency: 'USD',
      ...(v.priceLink ? { priceLink: { ...v.priceLink, since: now } } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const link: PortfolioAsset = {
      id: newId(),
      portfolioId,
      instrumentId: instrument.id,
      ...(v.reminderDays ? { priceReminderDays: v.reminderDays } : {}),
      addedAt: now,
      updatedAt: now,
    };
    const prices: PricePoint[] = [
      { instrumentId: instrument.id, date: v.priceDate, close: v.price.toString(), source: v.priceFetched ? 'link' : 'manual', updatedAt: now },
    ];
    const txs: Transaction[] = [];
    if (v.starting) {
      const { quantity, costPerUnit, date } = v.starting;
      if (date < v.priceDate) {
        prices.push({ instrumentId: instrument.id, date, close: costPerUnit.toString(), source: 'manual', updatedAt: now });
      }
      txs.push({
        id: newId(),
        seq: nextSeq(),
        portfolioId,
        type: 'OPENING',
        date,
        instrumentId: instrument.id,
        quantity: quantity.toString(),
        price: costPerUnit.toString(),
        amount: quantity.mul(costPerUnit).toString(),
        note: 'Starting position',
        createdAt: now,
      });
    }

    await db.write([S.instruments, S.portfolioAssets, S.prices, S.transactions], ({ put }) => {
      put(S.instruments, instrument);
      put(S.portfolioAssets, link);
      for (const p of prices) put(S.prices, p);
      for (const t of txs) put(S.transactions, t);
    });
    return link;
  },

  /** The shared definition of a ticker, if any portfolio already uses it. */
  async findMarketInstrument(symbol: string): Promise<Instrument | undefined> {
    const db = await getDb();
    const rows = await db.getAllByIndex<Instrument>(S.instruments, 'symbol', symbol.toUpperCase());
    return rows.find((i) => i.priceSource === 'market');
  },

  /**
   * Adds a ticker to a portfolio in one atomic write: the instrument (reused if
   * another portfolio already has it), the link, downloaded price points and
   * an OPENING entry for a starting position.
   */
  async addMarketAsset(
    portfolioId: string,
    m: { symbol: string; name: string; exchange: string; assetClass: Instrument['assetClass'] },
    start: MarketStart,
    points: readonly Omit<PricePoint, 'instrumentId'>[],
  ): Promise<PortfolioAsset> {
    const db = await getDb();
    const now = new Date().toISOString();
    const symbol = m.symbol.toUpperCase();
    const existing = await this.findMarketInstrument(symbol);
    if (existing) {
      const links = await db.getAllByIndex<PortfolioAsset>(S.portfolioAssets, 'portfolioId', portfolioId);
      if (links.some((l) => l.instrumentId === existing.id)) throw new ValidationError(`${symbol} is already in this portfolio.`);
    }
    const instrument: Instrument = existing ?? {
      id: newId(),
      symbol,
      name: m.name,
      exchange: m.exchange,
      assetClass: m.assetClass,
      priceSource: 'market',
      currency: 'USD',
      createdAt: now,
      updatedAt: now,
    };
    const link: PortfolioAsset = { id: newId(), portfolioId, instrumentId: instrument.id, addedAt: now, updatedAt: now };
    const tx: Transaction | null = start && {
      id: newId(),
      seq: nextSeq(),
      portfolioId,
      type: 'OPENING',
      date: start.date,
      instrumentId: instrument.id,
      quantity: start.quantity.toString(),
      price: start.costPerUnit.toString(),
      amount: start.quantity.mul(start.costPerUnit).toString(),
      note: 'Starting position',
      createdAt: now,
    };
    await db.write([S.instruments, S.portfolioAssets, S.prices, S.transactions], ({ put }) => {
      if (!existing) put(S.instruments, instrument);
      put(S.portfolioAssets, link);
      for (const p of points) put(S.prices, { ...p, instrumentId: instrument.id });
      if (tx) put(S.transactions, tx);
    });
    return link;
  },

  /**
   * Saves an "Update holding" (price and/or units) atomically. Before writing,
   * the whole ledger is replayed with the new entries; if that fails (e.g.
   * reducing units on a date before they were held) nothing is saved.
   */
  async updateHolding(portfolioId: string, instrumentId: string, update: HoldingUpdate): Promise<void> {
    const db = await getDb();
    const instrument = await db.get<Instrument>(S.instruments, instrumentId);
    if (!instrument) throw new ValidationError('That asset no longer exists.');
    if (update.priceChanged && instrument.priceSource !== 'manual') {
      throw new ValidationError('Market prices come from the data feed and can’t be typed in.');
    }
    const records = holdingUpdateRecords(update, instrumentId, {
      portfolioId,
      date: update.date,
      newId,
      nextSeq,
      now: new Date().toISOString(),
    });
    const existing = await db.getAllByIndex<Transaction>(S.transactions, 'portfolioId', portfolioId);
    try {
      replayLedger([...existing, ...records.transactions]);
    } catch (err) {
      if (err instanceof LedgerError) {
        throw new ValidationError(`On ${update.date} the portfolio held fewer units than that. Pick a later date or a higher total.`);
      }
      throw err;
    }
    await db.write([S.prices, S.transactions, S.instruments], ({ put }) => {
      if (records.pricePoint) put(S.prices, records.pricePoint);
      for (const t of records.transactions) put(S.transactions, t);
      put(S.instruments, { ...instrument, updatedAt: new Date().toISOString() });
    });
  },

  /**
   * Adds, changes or removes (undefined) the price link of one or more manual
   * assets in one atomic write (e.g. the same fund in several portfolios).
   */
  async setPriceLink(instrumentIds: string | readonly string[], link: PriceLink | undefined): Promise<void> {
    const ids = typeof instrumentIds === 'string' ? [instrumentIds] : instrumentIds;
    const db = await getDb();
    const now = new Date().toISOString();
    const updated: Instrument[] = [];
    for (const id of ids) {
      const instrument = await db.get<Instrument>(S.instruments, id);
      if (!instrument) throw new ValidationError('That asset no longer exists.');
      if (instrument.priceSource !== 'manual') throw new ValidationError('Only manual-price assets can use a price link.');
      const { priceLink: old, ...rest } = instrument;
      // Keep the setup time when the code is unchanged (e.g. only the page address changed).
      const since = old && link && old.fundId === link.fundId && old.since ? old.since : now;
      updated.push({ ...rest, ...(link ? { priceLink: { ...link, since } } : {}), updatedAt: now });
    }
    await db.write([S.instruments], ({ put }) => {
      for (const i of updated) put(S.instruments, i);
    });
  },

  /** Ids of manual assets (any portfolio) with the same name — the same fund held elsewhere. */
  async sameFundIds(instrumentId: string): Promise<string[]> {
    const all = await this.listInstruments();
    const me = all.find((i) => i.id === instrumentId);
    if (!me) return [instrumentId];
    const key = groupKey(me.name);
    return all.filter((i) => i.priceSource === 'manual' && groupKey(i.name) === key).map((i) => i.id);
  },

  async setReminder(link: PortfolioAsset, reminderDays: number | undefined): Promise<void> {
    const db = await getDb();
    const { priceReminderDays: _old, ...rest } = link;
    const updated: PortfolioAsset = { ...rest, ...(reminderDays ? { priceReminderDays: reminderDays } : {}), updatedAt: new Date().toISOString() };
    await db.write([S.portfolioAssets], ({ put }) => put(S.portfolioAssets, updated));
  },

  /** What deleting this asset would remove — shown in the confirmation before anything changes. */
  async previewDelete(link: PortfolioAsset): Promise<AssetDeletionPlan> {
    const txs = await transactionRepo.listForPortfolio(link.portfolioId);
    return planAssetDeletion(txs, link.instrumentId);
  },

  /**
   * Deletes an asset from a portfolio as if it had never been added: the link,
   * its ledger entries (see domain/assets/deleteAsset.ts) and — when no other
   * portfolio uses it — the asset definition and its price history.
   * One atomic write; tombstones let a backup merge delete it on other devices.
   */
  async deleteAsset(link: PortfolioAsset): Promise<void> {
    const db = await getDb();
    const plan = await this.previewDelete(link);
    const others = (await db.getAllByIndex<PortfolioAsset>(S.portfolioAssets, 'instrumentId', link.instrumentId)).filter(
      (l) => l.id !== link.id,
    );
    const dropInstrument = others.length === 0;
    const now = new Date().toISOString();
    const tombstones: Deletion[] = [
      { id: link.id, store: S.portfolioAssets, deletedAt: now },
      ...plan.removeIds.map((id) => ({ id, store: S.transactions, deletedAt: now })),
      ...(dropInstrument ? [{ id: link.instrumentId, store: S.instruments, deletedAt: now }] : []),
    ];
    await db.write([S.portfolioAssets, S.transactions, S.instruments, S.prices, S.deletions], ({ put, del, deleteByIndex }) => {
      del(S.portfolioAssets, link.id);
      for (const id of plan.removeIds) del(S.transactions, id);
      if (dropInstrument) {
        del(S.instruments, link.instrumentId);
        deleteByIndex(S.prices, 'instrumentId', link.instrumentId);
      }
      for (const t of tombstones) put(S.deletions, t);
    });
  },
};

export const transactionRepo = {
  async listForPortfolio(portfolioId: string): Promise<Transaction[]> {
    return (await getDb()).getAllByIndex<Transaction>(S.transactions, 'portfolioId', portfolioId);
  },
  async listAll(): Promise<Transaction[]> {
    return (await getDb()).getAll<Transaction>(S.transactions);
  },
};

export const priceRepo = {
  async listForInstrument(instrumentId: string): Promise<PricePoint[]> {
    return (await getDb()).getAllByIndex<PricePoint>(S.prices, 'instrumentId', instrumentId);
  },
  async listAll(): Promise<PricePoint[]> {
    return (await getDb()).getAll<PricePoint>(S.prices);
  },
  /** Writes market price points (a same-day point replaces the earlier one). */
  async putMany(points: readonly PricePoint[]): Promise<void> {
    if (points.length === 0) return;
    await (await getDb()).write([S.prices], ({ put }) => {
      for (const p of points) put(S.prices, p);
    });
  },
};
