/**
 * Database schema and migrations.
 *
 * To change the schema later: bump DB_VERSION and add a new `if (oldVersion < N)`
 * block. Never edit an existing block — users' browsers have already run it.
 */

import { Database } from './idb';

export const DB_NAME = 'portfolio-tracker';
export const DB_VERSION = 2;

export const S = {
  portfolios: 'portfolios',
  instruments: 'instruments',
  portfolioAssets: 'portfolioAssets', // which assets each portfolio tracks (v2)
  deletions: 'deletions', // tombstones for backup merge / sync (v2)
  transactions: 'transactions',
  allocationPlans: 'allocationPlans',
  contributionRules: 'contributionRules',
  switches: 'switches',
  prices: 'prices', // daily closes + manual prices, key [instrumentId, date]
  settings: 'settings', // key/value pairs, e.g. the API key
} as const;

export function openAppDatabase(): Promise<Database> {
  return Database.open(DB_NAME, DB_VERSION, (db, _tx, oldVersion) => {
    if (oldVersion < 1) {
      db.createObjectStore(S.portfolios, { keyPath: 'id' });

      const instruments = db.createObjectStore(S.instruments, { keyPath: 'id' });
      instruments.createIndex('symbol', 'symbol', { unique: false });

      const txs = db.createObjectStore(S.transactions, { keyPath: 'id' });
      txs.createIndex('portfolioId', 'portfolioId', { unique: false });

      const plans = db.createObjectStore(S.allocationPlans, { keyPath: 'id' });
      plans.createIndex('portfolioId', 'portfolioId', { unique: false });

      const rules = db.createObjectStore(S.contributionRules, { keyPath: 'id' });
      rules.createIndex('portfolioId', 'portfolioId', { unique: false });

      const switches = db.createObjectStore(S.switches, { keyPath: 'id' });
      switches.createIndex('fromPortfolioId', 'fromPortfolioId', { unique: false });
      switches.createIndex('toPortfolioId', 'toPortfolioId', { unique: false });

      const prices = db.createObjectStore(S.prices, { keyPath: ['instrumentId', 'date'] });
      prices.createIndex('instrumentId', 'instrumentId', { unique: false });

      db.createObjectStore(S.settings, { keyPath: 'key' });
    }

    if (oldVersion < 2) {
      const assets = db.createObjectStore(S.portfolioAssets, { keyPath: 'id' });
      assets.createIndex('portfolioId', 'portfolioId', { unique: false });
      assets.createIndex('instrumentId', 'instrumentId', { unique: false });

      db.createObjectStore(S.deletions, { keyPath: 'id' });
    }
  });
}

let dbPromise: Promise<Database> | undefined;

/** The app's single database connection (opened on first use). */
export function getDb(): Promise<Database> {
  dbPromise ??= openAppDatabase();
  return dbPromise;
}
