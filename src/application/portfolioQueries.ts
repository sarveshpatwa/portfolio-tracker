/**
 * Read models for the screens: loads the raw records and runs the domain
 * calculations (ledger replay → valuation → breakdown). Screens never do
 * financial maths themselves.
 *
 * Loading everything at once is fine at personal scale (a few portfolios,
 * a few thousand ledger lines). If that ever gets slow, this is the single
 * place to add caching.
 */

import { Dec } from '../domain/money/decimal';
import { todayLocal, type IsoDate } from '../domain/calendar/dates';
import { replayLedger } from '../domain/portfolio/ledger';
import { valuePortfolio, type HoldingValue, type PortfolioValue } from '../domain/portfolio/valuation';
import { breakdownByClass, type ClassSlice } from '../domain/portfolio/breakdown';
import { manualPriceStatus, priceMap, pricesOnOrBefore, type DatedPrice, type ManualPriceStatus } from '../domain/pricing/prices';
import type { Instrument, Portfolio, PortfolioAsset, PricePoint, Transaction } from '../domain/types';
import { portfolioRepo } from '../data/repositories/portfolioRepo';
import { assetRepo, priceRepo, transactionRepo } from '../data/repositories/assetRepo';
import { S } from '../data/db/schema';

/** Stores whose changes should refresh portfolio screens. */
export const PORTFOLIO_STORES = [S.portfolios, S.portfolioAssets, S.instruments, S.prices, S.transactions] as const;

export interface PortfolioSummary {
  portfolio: Portfolio;
  assetCount: number;
  valuation: PortfolioValue;
  pricesDue: number;
}

export interface AssetRow {
  link: PortfolioAsset;
  instrument: Instrument;
  holding?: HoldingValue;
  quantity: Dec;
  price?: DatedPrice;
  manualStatus?: ManualPriceStatus;
}

export interface PortfolioDetail {
  portfolio: Portfolio;
  rows: AssetRow[];
  valuation: PortfolioValue;
  byClass: ClassSlice[];
  ledgerCount: number;
}

export async function loadPortfolioSummaries(today: IsoDate = todayLocal()): Promise<PortfolioSummary[]> {
  const [portfolios, links, instruments, txs, prices] = await Promise.all([
    portfolioRepo.list(),
    assetRepo.listAllLinks(),
    assetRepo.listInstruments(),
    transactionRepo.listAll(),
    priceRepo.listAll(),
  ]);
  const instrumentsById = new Map(instruments.map((i) => [i.id, i]));
  return portfolios.map((p) => {
    const own = links.filter((l) => l.portfolioId === p.id);
    const detail = compute(p, own, instrumentsById, txs.filter((t) => t.portfolioId === p.id), prices, today);
    return {
      portfolio: p,
      assetCount: own.length,
      valuation: detail.valuation,
      pricesDue: detail.rows.filter((r) => r.manualStatus?.updateDue).length,
    };
  });
}

export async function loadPortfolioDetail(portfolioId: string, today: IsoDate = todayLocal()): Promise<PortfolioDetail | null> {
  const portfolio = await portfolioRepo.get(portfolioId);
  if (!portfolio) return null;
  const [links, instruments, txs, prices] = await Promise.all([
    assetRepo.listForPortfolio(portfolioId),
    assetRepo.listInstruments(),
    transactionRepo.listForPortfolio(portfolioId),
    priceRepo.listAll(),
  ]);
  return compute(portfolio, links, new Map(instruments.map((i) => [i.id, i])), txs, prices, today);
}

export interface AssetDeletionPreview {
  entries: number;
  valueBefore: Dec;
  valueAfter: Dec;
  keptCash: Dec;
  cashGoesNegative: boolean;
}

/** Before/after numbers for the "Delete asset" confirmation. */
export async function previewAssetDeletion(link: PortfolioAsset, today: IsoDate = todayLocal()): Promise<AssetDeletionPreview> {
  const [txs, prices, plan] = await Promise.all([
    transactionRepo.listForPortfolio(link.portfolioId),
    priceRepo.listAll(),
    assetRepo.previewDelete(link),
  ]);
  const map = priceMap(pricesOnOrBefore(prices, today));
  return {
    entries: plan.removeIds.length,
    valueBefore: valuePortfolio(replayLedger(txs), map).totalValue,
    valueAfter: valuePortfolio(replayLedger(plan.remaining), map).totalValue,
    keptCash: plan.keptCash,
    cashGoesNegative: plan.cashGoesNegative,
  };
}

function compute(
  portfolio: Portfolio,
  links: readonly PortfolioAsset[],
  instrumentsById: ReadonlyMap<string, Instrument>,
  txs: readonly Transaction[],
  allPrices: readonly PricePoint[],
  today: IsoDate,
): PortfolioDetail {
  const state = replayLedger(txs);
  const dated = pricesOnOrBefore(allPrices, today);
  const valuation = valuePortfolio(state, priceMap(dated));
  const holdingsById = new Map(valuation.holdings.map((h) => [h.instrumentId, h]));

  const rows: AssetRow[] = [];
  for (const link of links) {
    const instrument = instrumentsById.get(link.instrumentId);
    if (!instrument) continue; // defensive: a link to a missing instrument is skipped, not fatal
    const price = dated.get(instrument.id);
    const holding = holdingsById.get(instrument.id);
    rows.push({
      link,
      instrument,
      holding,
      quantity: holding?.quantity ?? Dec.ZERO,
      price,
      manualStatus:
        instrument.priceSource === 'manual' && price ? manualPriceStatus(price.date, today, link.priceReminderDays) : undefined,
    });
  }
  // Largest holdings first; assets with no units keep their added order at the end.
  rows.sort((a, b) => (b.holding?.value ?? Dec.ZERO).cmp(a.holding?.value ?? Dec.ZERO));

  const byClass = breakdownByClass(valuation, (id) => instrumentsById.get(id)?.assetClass ?? 'other');
  return { portfolio, rows, valuation, byClass, ledgerCount: txs.length };
}
