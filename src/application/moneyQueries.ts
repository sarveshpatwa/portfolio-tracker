/** Data for the Money & allocation and Ledger screens. */

import { replayLedger } from '../domain/portfolio/ledger';
import type { AllocationPlan, ContributionRule, Instrument, Portfolio, PortfolioAsset, Transaction } from '../domain/types';
import { assetRepo, transactionRepo } from '../data/repositories/assetRepo';
import { contributionRepo } from '../data/repositories/contributionRepo';
import { portfolioRepo } from '../data/repositories/portfolioRepo';
import { S } from '../data/db/schema';
import { Dec } from '../domain/money/decimal';

export const MONEY_STORES = [S.portfolios, S.portfolioAssets, S.instruments, S.allocationPlans, S.contributionRules, S.transactions, S.prices] as const;

export interface MoneyData {
  portfolio: Portfolio;
  assets: { link: PortfolioAsset; instrument: Instrument }[];
  plans: AllocationPlan[];
  rules: ContributionRule[];
  /** Number of contributions each rule has made so far. */
  runsByRule: Map<string, number>;
  cash: Dec;
}

export async function loadMoney(portfolioId: string): Promise<MoneyData | null> {
  const portfolio = await portfolioRepo.get(portfolioId);
  if (!portfolio) return null;
  const [links, instruments, plans, rules, txs] = await Promise.all([
    assetRepo.listForPortfolio(portfolioId),
    assetRepo.listInstruments(),
    contributionRepo.plans(portfolioId),
    contributionRepo.rules(portfolioId),
    transactionRepo.listForPortfolio(portfolioId),
  ]);
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const runsByRule = new Map<string, number>();
  for (const t of txs) {
    if (t.type !== 'DEPOSIT' || !t.contributionId?.startsWith('rc:')) continue;
    const ruleId = t.contributionId.split(':')[1]!;
    runsByRule.set(ruleId, (runsByRule.get(ruleId) ?? 0) + 1);
  }
  return {
    portfolio,
    assets: links.flatMap((link) => {
      const instrument = byId.get(link.instrumentId);
      return instrument ? [{ link, instrument }] : [];
    }),
    plans,
    rules,
    runsByRule,
    cash: Dec.max(Dec.ZERO, replayLedger(txs).cash),
  };
}

export interface LedgerGroup {
  key: string;
  date: string;
  title: string;
  subtitle?: string;
  total?: Dec;
  entries: Transaction[];
}

export async function loadLedger(portfolioId: string): Promise<{ portfolio: Portfolio; groups: LedgerGroup[]; names: Map<string, string>; count: number } | null> {
  const portfolio = await portfolioRepo.get(portfolioId);
  if (!portfolio) return null;
  const [txs, instruments, plans] = await Promise.all([
    transactionRepo.listForPortfolio(portfolioId),
    assetRepo.listInstruments(),
    contributionRepo.plans(portfolioId),
  ]);
  const names = new Map(instruments.map((i) => [i.id, i.symbol ?? i.name]));
  const versionOf = new Map(plans.map((p) => [p.id, p.version]));
  const sorted = [...txs].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.seq - a.seq));

  const groups: LedgerGroup[] = [];
  const byContribution = new Map<string, LedgerGroup>();
  for (const t of sorted) {
    if (t.contributionId) {
      let g = byContribution.get(t.contributionId);
      if (!g) {
        const recurring = t.contributionId.startsWith('rc:');
        const mirrored = t.contributionId.startsWith('mirror:');
        g = { key: t.contributionId, date: t.date, title: recurring ? 'Recurring contribution' : mirrored ? 'Mirrored from switch' : 'Contribution', entries: [] };
        byContribution.set(t.contributionId, g);
        groups.push(g);
      }
      g.entries.push(t);
      continue;
    }
    groups.push({ key: t.id, date: t.date, title: LABEL[t.type] ?? t.type, entries: [t] });
  }
  for (const g of groups) {
    if (g.entries.length < 2 && !g.key.startsWith('rc:')) continue;
    const deposit = g.entries.find((e) => e.type === 'DEPOSIT');
    const first = g.entries[0]!;
    if (deposit) g.total = Dec.from(deposit.amount);
    const parts: string[] = [];
    if (deposit?.note) parts.push(deposit.note.replace(/(\d+\.\d\d)/, (m) => `$${Number(m).toLocaleString('en-US', { minimumFractionDigits: 2 })}`));
    if (first.scheduledDate && first.scheduledDate !== first.date) parts.push(`scheduled ${first.scheduledDate}, traded ${first.date}`);
    if (first.allocationPlanId && versionOf.has(first.allocationPlanId)) parts.push(`allocation v${versionOf.get(first.allocationPlanId)}`);
    if (parts.length) g.subtitle = parts.join(' · ');
    // Deposit first, then purchases.
    g.entries.sort((a, b) => (a.type === 'DEPOSIT' ? -1 : b.type === 'DEPOSIT' ? 1 : a.seq - b.seq));
  }
  return { portfolio, groups, names, count: txs.length };
}

export const LABEL: Record<string, string> = {
  DEPOSIT: 'Deposit',
  WITHDRAW: 'Withdrawal',
  BUY: 'Buy',
  SELL: 'Sell',
  OPENING: 'Starting position',
  REINVEST: 'Earned units',
  FEE: 'Fee',
};

/** Ledger as CSV (opens in Excel/Numbers). */
export function ledgerCsv(txs: readonly Transaction[], names: ReadonlyMap<string, string>): string {
  const rows = [['date', 'type', 'asset', 'quantity', 'price', 'amount', 'note', 'scheduled_date', 'contribution_id']];
  const sorted = [...txs].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.seq - b.seq));
  for (const t of sorted) {
    rows.push([t.date, LABEL[t.type] ?? t.type, t.instrumentId ? names.get(t.instrumentId) ?? '' : '', t.quantity ?? '', t.price ?? '', t.amount, t.note ?? '', t.scheduledDate ?? '', t.contributionId ?? '']);
  }
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
}
