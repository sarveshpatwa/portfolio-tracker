/**
 * Books estimated monthly dividends for $1.00 income funds on their payable
 * date (see domain/income/dividends.ts). Runs after recurring contributions on
 * every price-service tick, so the month's purchases are already in the ledger.
 */

import { todayInNewYork, type IsoDate } from '../domain/calendar/dates';
import { dueDividends, estimateMonth, monthOf, type MonthEstimate } from '../domain/income/dividends';
import type { Instrument, Transaction } from '../domain/types';
import { assetRepo, transactionRepo } from '../data/repositories/assetRepo';
import { contributionRepo } from '../data/repositories/contributionRepo';
import { nextSeq } from '../data/ids';

class IncomeService {
  private queue: Promise<unknown> = Promise.resolve();

  runDue(now = new Date()): Promise<number> {
    const run = this.queue.then(() => this.doRun(now));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doRun(now: Date): Promise<number> {
    const funds = (await assetRepo.listInstruments()).filter((i) => i.income && i.income.yields.length > 0);
    if (funds.length === 0) return 0;
    const links = await assetRepo.listAllLinks();
    const today = todayInNewYork(now);
    let booked = 0;
    for (const fund of funds) {
      for (const link of links.filter((l) => l.instrumentId === fund.id)) {
        const txs = await transactionRepo.listForPortfolio(link.portfolioId);
        const due = dueDividends({ instrument: fund, portfolioId: link.portfolioId, txs, today, nextSeq, now: now.toISOString() });
        if (due.length) {
          await contributionRepo.addContribution(link.portfolioId, due);
          booked += due.length;
        }
      }
    }
    return booked;
  }
}

export const incomeService = new IncomeService();

export interface IncomeStatus {
  /** This month's estimate so far (through today). */
  accrued: MonthEstimate | null;
  currentYield: { date: IsoDate; pct: string } | null;
  /** Booked dividends (newest first). */
  dividends: Transaction[];
}

export async function loadIncomeStatus(fund: Instrument, portfolioId: string, today: IsoDate = todayInNewYork()): Promise<IncomeStatus> {
  const txs = await transactionRepo.listForPortfolio(portfolioId);
  const yields = fund.income?.yields ?? [];
  return {
    accrued: yields.length ? estimateMonth(txs, fund.id, yields, monthOf(today), today) : null,
    currentYield: yields.length ? yields[yields.length - 1]! : null,
    dividends: txs.filter((t) => t.id.startsWith(`div:${fund.id}:${portfolioId}:`)).sort((a, b) => b.date.localeCompare(a.date)),
  };
}
