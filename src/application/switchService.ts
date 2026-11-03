/**
 * Runs "mirror new money" for every switch that has it on: contributions to
 * the new portfolio are copied into the old (baseline) portfolio — see
 * domain/switches/tracking.ts. Runs after recurring contributions on every
 * price-service tick, so a recurring buy is mirrored in the same tick.
 */

import { latestCompletedTradingDay } from '../domain/market/marketHours';
import { mirrorContributions } from '../domain/switches/tracking';
import { assetRepo, priceRepo, transactionRepo } from '../data/repositories/assetRepo';
import { contributionRepo } from '../data/repositories/contributionRepo';
import { portfolioRepo } from '../data/repositories/portfolioRepo';
import { switchRepo } from '../data/repositories/switchRepo';
import { nextSeq } from '../data/ids';

class SwitchService {
  private queue: Promise<unknown> = Promise.resolve();
  /** Last problem per switch id (e.g. a missing price), for the switch card. */
  readonly problems = new Map<string, string>();

  runMirrors(now = new Date()): Promise<number> {
    const run = this.queue.then(() => this.doRun(now));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doRun(now: Date): Promise<number> {
    const switches = (await switchRepo.list()).filter((s) => s.mirrorContributions);
    if (switches.length === 0) return 0;
    const [portfolios, links, instruments, points, plans] = await Promise.all([
      portfolioRepo.list(),
      assetRepo.listAllLinks(),
      assetRepo.listInstruments(),
      priceRepo.listAll(),
      contributionRepo.allPlans(),
    ]);
    const instById = new Map(instruments.map((i) => [i.id, i]));
    let made = 0;
    for (const sw of switches) {
      const baseline = portfolios.find((p) => p.id === sw.fromPortfolioId);
      if (!baseline || !portfolios.some((p) => p.id === sw.toPortfolioId)) continue;
      const [newTxs, baselineTxs] = await Promise.all([transactionRepo.listForPortfolio(sw.toPortfolioId), transactionRepo.listForPortfolio(baseline.id)]);
      const run = mirrorContributions({
        sw,
        baseline,
        newTxs,
        baselineTxs,
        baselinePlans: plans.filter((p) => p.portfolioId === baseline.id),
        baselineAssetIds: new Set(links.filter((l) => l.portfolioId === baseline.id).map((l) => l.instrumentId)),
        instruments: instById,
        points,
        throughTradeDate: latestCompletedTradingDay(now),
        nextSeq,
        now: now.toISOString(),
      });
      if (run.transactions.length) {
        await contributionRepo.addContribution(baseline.id, run.transactions);
        made += run.mirrored;
      }
      if (run.blocked) this.problems.set(sw.id, run.blocked);
      else this.problems.delete(sw.id);
    }
    return made;
  }
}

export const switchService = new SwitchService();
