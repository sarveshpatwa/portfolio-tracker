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
import { addMonths, todayInNewYork, todayLocal, type IsoDate } from '../domain/calendar/dates';
import { replayLedger } from '../domain/portfolio/ledger';
import { valuePortfolio, type HoldingValue, type PortfolioValue } from '../domain/portfolio/valuation';
import { breakdownByClass, type ClassSlice } from '../domain/portfolio/breakdown';
import { manualPriceStatus, priceMap, priceOnOrBefore, pricesOnOrBefore, type DatedPrice, type ManualPriceStatus } from '../domain/pricing/prices';
import type { Instrument, Portfolio, PortfolioAsset, PricePoint, SignalSettings, Transaction } from '../domain/types';
import { portfolioRepo } from '../data/repositories/portfolioRepo';
import { assetRepo, priceRepo, transactionRepo } from '../data/repositories/assetRepo';
import { S } from '../data/db/schema';
import { contributionRepo } from '../data/repositories/contributionRepo';
import { nextScheduledDate } from '../domain/contributions/schedule';
import { FREQUENCIES } from '../domain/contributions/forms';
import { formatUsd } from '../domain/money/format';
import { cagr, thin, valueHistory, type DayValue } from '../domain/portfolio/history';
import { yearlyContributions } from '../domain/portfolio/projection';
import { hasDailyPrices, holdingSignals, settingsWithDefaults, type Signal } from '../domain/signals/holdingSignals';
import { riskProfile, type RiskProfile } from '../domain/signals/risk';

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Stores whose changes should refresh portfolio screens. */
export const PORTFOLIO_STORES = [S.portfolios, S.portfolioAssets, S.instruments, S.prices, S.transactions, S.contributionRules] as const;

export interface PortfolioSummary {
  portfolio: Portfolio;
  /** Value over the last 3 months (thinned) for the card's trend line. */
  trend: DayValue[];
  /** Number of warning / watch signals across holdings. */
  signalCounts: { warning: number; watch: number };
  assetCount: number;
  valuation: PortfolioValue;
  pricesDue: number;
  /** e.g. "$500 monthly · next Nov 6" for active recurring rules. */
  recurring: string[];
}

export interface AssetRow {
  link: PortfolioAsset;
  instrument: Instrument;
  holding?: HoldingValue;
  quantity: Dec;
  price?: DatedPrice;
  manualStatus?: ManualPriceStatus;
  /** Price on (or the last one before) a date — used to price unit changes on past dates. */
  priceOn: (date: IsoDate) => DatedPrice | undefined;
}

export interface PortfolioDetail {
  portfolio: Portfolio;
  rows: AssetRow[];
  valuation: PortfolioValue;
  byClass: ClassSlice[];
  ledgerCount: number;
}

export async function loadPortfolioSummaries(today: IsoDate = todayLocal()): Promise<PortfolioSummary[]> {
  const [portfolios, links, instruments, txs, prices, rules] = await Promise.all([
    portfolioRepo.list(),
    assetRepo.listAllLinks(),
    assetRepo.listInstruments(),
    transactionRepo.listAll(),
    priceRepo.listAll(),
    contributionRepo.allRules(),
  ]);
  const instrumentsById = new Map(instruments.map((i) => [i.id, i]));
  return portfolios.map((p) => {
    const own = links.filter((l) => l.portfolioId === p.id);
    const detail = compute(p, own, instrumentsById, txs.filter((t) => t.portfolioId === p.id), prices, today);
    const sig = signalsFor(detail, prices);
    const all = sig.flatMap((h) => h.signals);
    const warning = all.filter((x) => x.severity === 'warning').length;
    const series = historyFor(txs.filter((t) => t.portfolioId === p.id), prices, today);
    const from = addMonths(series[series.length - 1]?.date ?? today, -3);
    return {
      portfolio: p,
      trend: thin(series.filter((d) => d.date >= from), 48),
      signalCounts: { warning, watch: all.length - warning },
      assetCount: own.length,
      valuation: detail.valuation,
      pricesDue: detail.rows.filter((r) => r.manualStatus?.updateDue).length,
      recurring: rules
        .filter((r) => r.portfolioId === p.id && !r.paused)
        .map((r) => {
          const next = nextScheduledDate(r, today);
          const label = FREQUENCIES.find((f) => f.value === r.frequency)?.label.toLowerCase() ?? r.frequency;
          return `${formatUsd(r.amount)} ${label}${next ? ` · next ${shortDate.format(new Date(`${next}T00:00:00Z`))}` : ''}`;
        }),
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
    const own = allPrices.filter((p) => p.instrumentId === instrument.id);
    rows.push({
      link,
      instrument,
      priceOn: (date) => priceOnOrBefore(own, date),
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

/**
 * History ends on today's New York date (trading days are New York days).
 * A manual price typed with a later local date (India is ahead) is moved onto
 * that end date so it still counts, matching the dashboard total.
 */
function historyFor(txs: readonly Transaction[], prices: readonly PricePoint[], localToday: IsoDate): DayValue[] {
  const ny = todayInNewYork();
  const end = ny < localToday ? ny : localToday;
  const pts = prices.filter((p) => p.date <= localToday).map((p) => (p.date > end ? { ...p, date: end } : p));
  return valueHistory(txs.map((t) => (t.date > end ? { ...t, date: end } : t)), pts, end);
}

export interface HoldingSignals {
  instrumentId: string;
  name: string;
  signals: Signal[];
}

export interface PortfolioHistory {
  series: DayValue[];
  /** Annualised return, or null with under 3 months of history. */
  annual: { rate: number; days: number } | null;
  /** Yearly amount of running recurring contributions. */
  yearlyContribution: number;
  /** Holdings with at least one signal, warnings first. */
  signals: HoldingSignals[];
  risk: RiskProfile;
  settings: SignalSettings;
}

/** Signals for every held asset (information only — nothing is traded). */
function signalsFor(detail: PortfolioDetail, prices: readonly PricePoint[]): HoldingSignals[] {
  const settings = settingsWithDefaults(detail.portfolio.signalSettings);
  const out: HoldingSignals[] = [];
  for (const row of detail.rows) {
    if (!row.holding || row.quantity.isZero()) continue;
    const own = prices
      .filter((p) => p.instrumentId === row.instrument.id && p.date <= todayLocal())
      .map((p) => ({ date: p.date, close: Dec.from(p.close).toNumber() }));
    const signals = holdingSignals({
      prices: own,
      weight: row.holding.weight.toNumber(),
      ...(row.link.stopLoss ? { stopLoss: Dec.from(row.link.stopLoss).toNumber() } : {}),
      settings,
    });
    if (signals.length) out.push({ instrumentId: row.instrument.id, name: row.instrument.symbol ?? row.instrument.name, signals });
  }
  const rank = (h: HoldingSignals) => (h.signals.some((x) => x.severity === 'warning') ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

function riskFor(detail: PortfolioDetail, series: readonly DayValue[], prices: readonly PricePoint[]): RiskProfile {
  const holdings = detail.valuation.holdings.filter((h) => h.value.isPositive());
  const total = detail.valuation.totalValue.toNumber();
  const weights = holdings.map((h) => h.weight.toNumber());
  if (total > 0 && detail.valuation.cash.isPositive()) weights.push(detail.valuation.cash.toNumber() / total);
  const sparse = holdings
    .filter((h) => !hasDailyPrices(prices.filter((p) => p.instrumentId === h.instrumentId).map((p) => ({ date: p.date, close: 0 }))))
    .reduce((a, h) => a + h.weight.toNumber(), 0);
  return riskProfile(series, weights, sparse);
}

export async function loadPortfolioHistory(portfolioId: string, today: IsoDate = todayLocal()): Promise<PortfolioHistory | null> {
  const portfolio = await portfolioRepo.get(portfolioId);
  if (!portfolio) return null;
  const [txs, prices, rules, links, instruments] = await Promise.all([
    transactionRepo.listForPortfolio(portfolioId),
    priceRepo.listAll(),
    contributionRepo.rules(portfolioId),
    assetRepo.listForPortfolio(portfolioId),
    assetRepo.listInstruments(),
  ]);
  const series = historyFor(txs, prices, today);
  const detail = compute(portfolio, links, new Map(instruments.map((i) => [i.id, i])), txs, prices, today);
  return {
    series,
    annual: cagr(series),
    yearlyContribution: yearlyContributions(rules, today),
    signals: signalsFor(detail, prices),
    risk: riskFor(detail, series, prices),
    settings: settingsWithDefaults(portfolio.signalSettings),
  };
}
