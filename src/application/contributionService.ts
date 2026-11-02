/**
 * Contribution engine glue: one-time contributions (with live preview) and
 * running recurring rules.
 *
 * Recurring rules are checked after every price-service tick (app start, once
 * a minute, coming back to the app). Each due date runs at that day's final
 * close — see domain/contributions/execution.ts. Rules waiting for a close or
 * blocked by a problem report it here so the screen can say why.
 */

import { Dec } from '../domain/money/decimal';
import { todayLocal, type IsoDate } from '../domain/calendar/dates';
import { latestCompletedTradingDay } from '../domain/market/marketHours';
import { planInEffect } from '../domain/contributions/allocation';
import { pricesForTrade, runRecurring, usableTargets, type MissingPrice } from '../domain/contributions/execution';
import { planPurchase, type PurchasePlan } from '../domain/contributions/purchase';
import { contributionTransactions } from '../domain/contributions/transactions';
import { replayLedger } from '../domain/portfolio/ledger';
import type { AllocationPlan, Id, Instrument, Portfolio } from '../domain/types';
import { assetRepo, priceRepo, transactionRepo } from '../data/repositories/assetRepo';
import { contributionRepo } from '../data/repositories/contributionRepo';
import { portfolioRepo } from '../data/repositories/portfolioRepo';
import { newId, nextSeq } from '../data/ids';

export type RuleStatus = { kind: 'waiting'; scheduledDate: IsoDate } | { kind: 'blocked'; scheduledDate: IsoDate; message: string };

type Listener = () => void;

export interface OneTimePreview {
  plan?: AllocationPlan;
  planOk: boolean;
  purchase?: PurchasePlan;
  priceDates: Map<Id, IsoDate>;
  missing: MissingPrice[];
  cashAvailable: Dec;
  cashUsed: Dec;
  error?: string;
}

class ContributionService {
  private statuses = new Map<Id, RuleStatus>();
  private listeners = new Set<Listener>();
  /** Runs are queued one after another, so a run requested after a change always sees it. */
  private queue: Promise<unknown> = Promise.resolve();
  private version = 0;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;
  statusOf(ruleId: Id): RuleStatus | undefined {
    return this.statuses.get(ruleId);
  }
  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Runs every due recurring contribution. Returns how many contributions were made. */
  runDue(now?: Date): Promise<number> {
    const run = this.queue.then(() => this.doRun(now ?? new Date()));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doRun(now: Date): Promise<number> {
    const rules = (await contributionRepo.allRules()).filter((r) => !r.paused);
    if (rules.length === 0) {
      if (this.statuses.size) {
        this.statuses.clear();
        this.emit();
      }
      return 0;
    }
    const [portfolios, plans, links, instruments, points] = await Promise.all([
      portfolioRepo.list(),
      contributionRepo.allPlans(),
      assetRepo.listAllLinks(),
      assetRepo.listInstruments(),
      priceRepo.listAll(),
    ]);
    const instById = new Map(instruments.map((i) => [i.id, i]));
    const through = latestCompletedTradingDay(now);
    let made = 0;
    const statuses = new Map<Id, RuleStatus>();

    for (const rule of rules) {
      const portfolio = portfolios.find((p) => p.id === rule.portfolioId);
      if (!portfolio) continue;
      const run = runRecurring({
        rule,
        portfolio,
        plans: plans.filter((p) => p.portfolioId === portfolio.id),
        assetIds: new Set(links.filter((l) => l.portfolioId === portfolio.id).map((l) => l.instrumentId)),
        instruments: instById,
        points,
        throughTradeDate: through,
        nextSeq,
        now: now.toISOString(),
        nameOf: (id) => displayName(instById.get(id)),
      });
      if (run.executed.length > 0 && run.lastScheduledDate) {
        await contributionRepo.recordRecurring(
          rule,
          run.executed.flatMap((e) => e.transactions),
          run.lastScheduledDate,
        );
        made += run.executed.length;
      }
      if (run.blocked) statuses.set(rule.id, { kind: 'blocked', ...run.blocked });
      else if (run.waiting) statuses.set(rule.id, { kind: 'waiting', scheduledDate: run.waiting.scheduledDate });
    }
    this.statuses = statuses;
    this.emit();
    return made;
  }

  /** What a one-time contribution would buy, before saving. */
  async previewOneTime(portfolio: Portfolio, amount: Dec | null, date: IsoDate, investCash: boolean, today: IsoDate = todayLocal()): Promise<OneTimePreview> {
    const [plans, links, instruments, points, txs] = await Promise.all([
      contributionRepo.plans(portfolio.id),
      assetRepo.listForPortfolio(portfolio.id),
      assetRepo.listInstruments(),
      priceRepo.listAll(),
      transactionRepo.listForPortfolio(portfolio.id),
    ]);
    const plan = planInEffect(plans, today) ?? plans[plans.length - 1];
    const { targets, ok } = usableTargets(plan, new Set(links.map((l) => l.instrumentId)));
    const cashAvailable = Dec.max(Dec.ZERO, replayLedger(txs).cash);
    const base: OneTimePreview = { ...(plan ? { plan } : {}), planOk: ok, priceDates: new Map(), missing: [], cashAvailable, cashUsed: Dec.ZERO };
    if (!ok) return base;
    const instById = new Map(instruments.map((i) => [i.id, i] as [Id, Instrument]));
    const tp = pricesForTrade(
      targets.map((t) => t.instrumentId),
      instById,
      points,
      date,
      date >= today ? 'latest' : 'asOf',
    );
    const result: OneTimePreview = { ...base, priceDates: tp.dates, missing: tp.missing };
    if (!amount || tp.missing.length > 0) return result;
    // Existing cash can only join a contribution dated today (it may not have existed on a past date).
    // Sub-cent leftovers from fractional buys aren't worth investing (they'd only show as "$0.00").
    const cashUsed = investCash && date >= today && cashAvailable.gte('0.01') ? cashAvailable : Dec.ZERO;
    try {
      result.purchase = planPurchase({
        amount: amount.add(cashUsed),
        targets,
        prices: tp.prices,
        mode: portfolio.buyMode,
        fractionDigits: portfolio.fractionDigits,
        topUpWholeShares: portfolio.topUpWholeShares,
      });
      result.cashUsed = cashUsed;
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Couldn’t plan the purchase.';
    }
    return result;
  }

  async addOneTime(portfolio: Portfolio, amount: Dec, date: IsoDate, investCash: boolean): Promise<PurchasePlan> {
    const preview = await this.previewOneTime(portfolio, amount, date, investCash);
    if (!preview.planOk || !preview.plan) throw new Error('Set a target allocation that totals 100% first.');
    if (preview.missing.length) throw new Error('Some assets have no price for that date.');
    if (!preview.purchase) throw new Error(preview.error ?? 'Couldn’t plan the purchase.');
    const txs = contributionTransactions(
      preview.purchase,
      { portfolioId: portfolio.id, date, newId, nextSeq, now: new Date().toISOString() },
      { allocationPlanId: preview.plan.id, depositAmount: amount, note: `One-time ${amount.toFixed(2)}` },
    );
    await contributionRepo.addContribution(portfolio.id, txs);
    return preview.purchase;
  }
}

export function displayName(i: Instrument | undefined): string {
  return i ? (i.symbol ?? i.name) : 'an asset';
}

export const contributionService = new ContributionService();
