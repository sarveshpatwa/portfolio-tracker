/**
 * Core domain types. These are plain data (no classes) so they can be stored
 * in IndexedDB as-is. All money, price and quantity fields are decimal strings
 * (see money/decimal.ts) — never JavaScript numbers.
 */

import type { IsoDate } from './calendar/dates';

export type Id = string;
export type DecimalString = string;

export type BuyMode = 'fractional' | 'whole';

/**
 * Sync-friendly bookkeeping (used by backup merge and, later, automatic sync):
 *  - Every record has a random unique `id`, so records from two devices never clash.
 *  - Editable records carry `updatedAt`; when the same record was changed on
 *    both devices, the newer `updatedAt` wins.
 *  - Deletions leave a small `Deletion` tombstone so a merge can remove the
 *    record on the other device too, instead of bringing it back.
 *  - Ledger transactions are never edited, only added, so they merge by id.
 */
export interface Deletion {
  id: Id; // id of the deleted record
  store: string;
  deletedAt: string;
}

export interface Portfolio {
  id: Id;
  name: string;
  createdAt: string; // ISO timestamp
  updatedAt?: string; // absent on records created before schema v2 → treat as createdAt
  /** First day the portfolio is tracked (e.g. a switch date). Optional for portfolios that start "now". */
  startDate?: IsoDate;
  /** How contributions buy shares. */
  buyMode: BuyMode;
  /** Decimal places for fractional shares (default 6). */
  fractionDigits: number;
  /** Whole-share mode: spend leftover cash on the most under-weight asset. */
  topUpWholeShares: boolean;
  /** Optional annual fee as a percentage, e.g. "1.0" for 1%/yr. Absent = no fee. */
  annualFeePct?: DecimalString;
  /** Signal thresholds for this portfolio (absent = defaults, see signals/holdingSignals.ts). */
  signalSettings?: SignalSettings;
}

/** Thresholds for holding signals. Percentages are plain numbers, e.g. 10 for 10%. */
export interface SignalSettings {
  /** Price fell at least this % over `declineDays` calendar days. */
  declinePct: number;
  declineDays: number;
  /** Price is at least this % below its 52-week high. */
  drawdownPct: number;
  /** One holding is at least this % of the portfolio. */
  concentrationPct: number;
  /** Recent (20-day) volatility is at least this many times its usual level. */
  volatilityMultiple: number;
  /** Warn when the price is below its N-day average (0 = off). */
  movingAverageDays: number;
}

export type AssetClass = 'stock' | 'etf' | 'bond' | 'fund' | 'other';
export type PriceSource = 'market' | 'manual';

/** A thing that can be held. Shared across portfolios (one VTI record for everyone). */
export interface Instrument {
  id: Id;
  /** Ticker for market instruments (e.g. "VTI"); absent for manual assets. */
  symbol?: string;
  /** Listing exchange shown to the user, e.g. "NYSE Arca" (market instruments). */
  exchange?: string;
  name: string;
  assetClass: AssetClass;
  priceSource: PriceSource;
  currency: 'USD';
  /**
   * Manual assets only: fetch the daily price from the fund's Vanguard page
   * data (see pricing/priceLink.ts). Typed prices keep working alongside it.
   */
  priceLink?: { url: string; fundId: string; since?: string };
  createdAt: string;
  updatedAt: string;
}

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  stock: 'Stock',
  etf: 'ETF',
  bond: 'Bond',
  fund: 'Fund',
  other: 'Other',
};

/**
 * An asset a portfolio tracks. Exists even before any shares are held, so an
 * asset can be added first and bought later through contributions.
 */
export interface PortfolioAsset {
  id: Id;
  portfolioId: Id;
  instrumentId: Id;
  /** Manual assets: remind to update the price after this many days (7, 14…). Absent = never. */
  priceReminderDays?: number;
  /** Optional alert level: a warning when the price is at or below it (the app never sells). */
  stopLoss?: DecimalString;
  addedAt: string;
  updatedAt: string;
}

export type TransactionType =
  | 'DEPOSIT' // simulated cash added
  | 'WITHDRAW' // cash removed
  | 'BUY' // cash → shares
  | 'SELL' // shares → cash
  | 'OPENING' // shares that already existed on the start date (switch baseline); no cash moves
  | 'REINVEST' // units received without new money (dividends/interest in units, bonus shares)
  | 'FEE'; // cash removed for fees

/**
 * One immutable ledger line. The ledger is the source of truth: holdings,
 * cost basis and cash are always DERIVED by replaying it (portfolio/ledger.ts).
 *
 * Sign convention: `quantity`, `price` and `amount` are always non-negative;
 * the `type` says which direction money and shares move.
 */
export interface Transaction {
  id: Id;
  portfolioId: Id;
  type: TransactionType;
  /** Trade date (the closing price used belongs to this day). */
  date: IsoDate;
  /** Required for BUY / SELL / OPENING / REINVEST. */
  instrumentId?: Id;
  /** Shares or units (BUY / SELL / OPENING / REINVEST). */
  quantity?: DecimalString;
  /** Price per share/unit (BUY / SELL / OPENING / REINVEST). */
  price?: DecimalString;
  /** Cash moved. For BUY/SELL/OPENING = quantity × price; for REINVEST, the units' value (no cash moves). */
  amount: DecimalString;
  /** Groups the deposit + buys created by one contribution. */
  contributionId?: Id;
  /** Which allocation plan version the buys used. */
  allocationPlanId?: Id;
  /** For recurring contributions: the date it was scheduled for (may differ from `date`). */
  scheduledDate?: IsoDate;
  /** Monotonic insertion order — tie-breaker for same-day entries. */
  seq: number;
  note?: string;
  createdAt: string;
}

export interface AllocationTarget {
  instrumentId: Id;
  /** Percent of each contribution, e.g. "40" for 40%. */
  pct: DecimalString;
}

/**
 * Allocation plans are versioned, never edited in place: editing creates a new
 * plan with a later `effectiveFrom`, so past contributions stay explainable.
 */
export interface AllocationPlan {
  id: Id;
  portfolioId: Id;
  version: number;
  effectiveFrom: IsoDate;
  targets: AllocationTarget[];
  createdAt: string;
}

export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly';

export interface ContributionRule {
  id: Id;
  portfolioId: Id;
  amount: DecimalString;
  frequency: Frequency;
  startDate: IsoDate;
  endDate?: IsoDate;
  paused: boolean;
  /** Last scheduled date already processed (so catch-up knows where to resume). */
  lastScheduledDate?: IsoDate;
  createdAt: string;
  updatedAt?: string;
}

/** Links a "what if I'd stayed" baseline portfolio to the portfolio the funds moved to. */
export interface PortfolioSwitch {
  id: Id;
  switchDate: IsoDate;
  fromPortfolioId: Id; // the baseline
  toPortfolioId: Id; // the new portfolio
  /** Baseline keeps its units forever (no rebalancing). */
  freezeBaseline: boolean;
  /** Money added to the new portfolio is also added to the baseline on the same dates. */
  mirrorContributions: boolean;
  /** Optional statement values used to sanity-check the entered units. */
  fromStatementValue?: DecimalString;
  toStatementValue?: DecimalString;
  /** Optional one-time cost of the move charged to the new portfolio. */
  oneTimeCost?: DecimalString;
  createdAt: string;
  updatedAt?: string;
}

/** A daily close (market), a user-entered price (manual) or a price fetched from a fund's price link (link). */
export interface PricePoint {
  instrumentId: Id;
  date: IsoDate;
  close: DecimalString;
  source: 'market' | 'manual' | 'link';
  /** When this point was written. Lets a backup merge keep the newer of two edits. */
  updatedAt?: string;
  /** Market prices only: a live price during the session, replaced by the final close later. */
  intraday?: boolean;
}
