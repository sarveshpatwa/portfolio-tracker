/**
 * Read model for the Compare screen: equal-money backtest (headline), each
 * portfolio's actual time-weighted record, and switch checks.
 */

import { Dec } from '../domain/money/decimal';
import { todayInNewYork, todayLocal, type IsoDate } from '../domain/calendar/dates';
import { runBacktest, periodStart, type Backtest, type ComparePeriod, type Mix } from '../domain/compare/backtest';
import { actualPerformance, type ActualPerformance } from '../domain/compare/actual';
import { planInEffect } from '../domain/contributions/allocation';
import { summariseSwitch, type SwitchSummary } from '../domain/switches/tracking';
import { checkAgainstStatement, type StatementCheck } from '../domain/switches/opening';
import type { Portfolio, PortfolioSwitch } from '../domain/types';
import { assetRepo, priceRepo, transactionRepo } from '../data/repositories/assetRepo';
import { contributionRepo } from '../data/repositories/contributionRepo';
import { portfolioRepo } from '../data/repositories/portfolioRepo';
import { switchRepo } from '../data/repositories/switchRepo';
import { S } from '../data/db/schema';
import { compute, historyFor } from './portfolioQueries';

export const COMPARE_STORES = [S.portfolios, S.portfolioAssets, S.instruments, S.prices, S.transactions, S.allocationPlans, S.switches] as const;

export type MixSource = 'holdings' | 'target';

export interface CompareOptions {
  period: ComparePeriod;
  amount: number;
  mix: MixSource;
  assumeFlatBefore: boolean;
}

export interface SwitchCard {
  sw: PortfolioSwitch;
  fromName: string;
  toName: string;
  summary: SwitchSummary | null;
  fromCheck?: StatementCheck;
  toCheck?: StatementCheck;
}

export interface CompareData {
  portfolios: Portfolio[];
  backtest: Backtest | null;
  /** Portfolios left out of the backtest, and why. */
  excluded: { name: string; reason: string }[];
  /** Name of the asset that limits the start date, when it moved. */
  limitedByName?: string;
  actual: { portfolio: Portfolio; perf: ActualPerformance | null }[];
  switches: SwitchCard[];
  end: IsoDate;
}

export async function loadCompare(opts: CompareOptions, today: IsoDate = todayLocal()): Promise<CompareData> {
  const [portfolios, links, instruments, txs, prices, plans, switches] = await Promise.all([
    portfolioRepo.list(),
    assetRepo.listAllLinks(),
    assetRepo.listInstruments(),
    transactionRepo.listAll(),
    priceRepo.listAll(),
    contributionRepo.allPlans(),
    switchRepo.list(),
  ]);
  const instById = new Map(instruments.map((i) => [i.id, i]));
  const ny = todayInNewYork();
  const end = ny < today ? ny : today;
  const start = periodStart(opts.period, end);

  const mixes: Mix[] = [];
  const excluded: CompareData['excluded'] = [];
  const histories = new Map<string, ReturnType<typeof historyFor>>();
  for (const p of portfolios) {
    const own = txs.filter((t) => t.portfolioId === p.id);
    histories.set(p.id, historyFor(own, prices, today));
    if (opts.mix === 'holdings') {
      const detail = compute(p, links.filter((l) => l.portfolioId === p.id), instById, own, prices, today);
      const total = detail.valuation.totalValue;
      if (!total.isPositive()) {
        excluded.push({ name: p.name, reason: 'no holdings yet' });
        continue;
      }
      mixes.push({
        portfolioId: p.id,
        name: p.name,
        lines: detail.valuation.holdings.filter((h) => h.value.isPositive()).map((h) => ({ instrumentId: h.instrumentId, weight: h.weight.toNumber() })),
      });
    } else {
      const plan = planInEffect(plans.filter((x) => x.portfolioId === p.id), today);
      if (!plan) {
        excluded.push({ name: p.name, reason: 'no target allocation' });
        continue;
      }
      mixes.push({ portfolioId: p.id, name: p.name, lines: plan.targets.map((t) => ({ instrumentId: t.instrumentId, weight: Dec.from(t.pct).toNumber() / 100 })) });
    }
  }
  // An asset with no price at all would block everyone: leave its portfolio out.
  const priced = new Set(prices.map((p) => p.instrumentId));
  const usable = mixes.filter((m) => {
    const missing = m.lines.find((l) => l.weight > 0 && !priced.has(l.instrumentId));
    if (missing) excluded.push({ name: m.name, reason: `no price yet for ${instById.get(missing.instrumentId)?.name ?? 'an asset'}` });
    return !missing;
  });
  const backtest = usable.length ? runBacktest(usable, prices, { amount: opts.amount, start, end, assumeFlatBefore: opts.assumeFlatBefore }) : null;
  const limited = backtest?.limitedBy ? instById.get(backtest.limitedBy.instrumentId) : undefined;

  const switchCards: SwitchCard[] = switches.map((sw) => {
    const from = portfolios.find((p) => p.id === sw.fromPortfolioId);
    const to = portfolios.find((p) => p.id === sw.toPortfolioId);
    const summary = from && to ? summariseSwitch(sw, histories.get(from.id) ?? [], histories.get(to.id) ?? [], to.annualFeePct) : null;
    const card: SwitchCard = { sw, fromName: from?.name ?? 'Deleted portfolio', toName: to?.name ?? 'Deleted portfolio', summary };
    if (summary && sw.fromStatementValue) card.fromCheck = checkAgainstStatement(Dec.from(summary.baselineStart.toFixed(2)), Dec.from(sw.fromStatementValue));
    if (summary && sw.toStatementValue) card.toCheck = checkAgainstStatement(Dec.from(summary.newStart.toFixed(2)), Dec.from(sw.toStatementValue));
    return card;
  });

  return {
    portfolios,
    backtest,
    excluded,
    ...(limited ? { limitedByName: limited.symbol ?? limited.name } : {}),
    actual: portfolios.map((p) => ({ portfolio: p, perf: actualPerformance(histories.get(p.id) ?? [], start) })),
    switches: switchCards,
    end,
  };
}

// ---------------------------------------------------------------------------
// Track a switch: what each portfolio looks like on the chosen date.

export interface SwitchSide {
  portfolio: Portfolio;
  /** The ledger already has entries on/before the switch date → use them as they are. */
  usesLedger: boolean;
  /** Value on the switch date from the ledger (when usesLedger). */
  ledgerValue: number;
  ledgerHoldings: number;
  assets: { instrumentId: string; name: string; manual: boolean; price?: { price: Dec; date: IsoDate } }[];
}

export async function loadSwitchSide(portfolioId: string, date: IsoDate): Promise<SwitchSide | null> {
  const portfolio = await portfolioRepo.get(portfolioId);
  if (!portfolio) return null;
  const [links, instruments, txs, prices] = await Promise.all([
    assetRepo.listForPortfolio(portfolioId),
    assetRepo.listInstruments(),
    transactionRepo.listForPortfolio(portfolioId),
    priceRepo.listAll(),
  ]);
  const instById = new Map(instruments.map((i) => [i.id, i]));
  const before = txs.filter((t) => t.date <= date);
  const usesLedger = before.length > 0;
  let ledgerValue = 0;
  let ledgerHoldings = 0;
  if (usesLedger) {
    const h = historyFor(txs, prices, todayLocal()).filter((d) => d.date <= date);
    ledgerValue = h[h.length - 1]?.value ?? 0;
    ledgerHoldings = new Set(before.filter((t) => t.instrumentId).map((t) => t.instrumentId)).size;
  }
  const assets = links.flatMap((l) => {
    const inst = instById.get(l.instrumentId);
    if (!inst) return [];
    const own = prices.filter((p) => p.instrumentId === inst.id && p.date <= date && !p.intraday);
    const best = own.reduce<(typeof own)[number] | undefined>((m, p) => (!m || p.date > m.date ? p : m), undefined);
    return [{ instrumentId: inst.id, name: inst.symbol ?? inst.name, manual: inst.priceSource === 'manual', ...(best ? { price: { price: Dec.from(best.close), date: best.date } } : {}) }];
  });
  return { portfolio, usesLedger, ledgerValue, ledgerHoldings, assets };
}
