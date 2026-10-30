import type { Transaction, TransactionType } from '../src/domain/types';

let seq = 0;

/** Builds a transaction with sensible defaults for tests. */
export function tx(
  type: TransactionType,
  date: string,
  fields: Partial<Omit<Transaction, 'type' | 'date'>> = {},
): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    portfolioId: 'p1',
    type,
    date,
    amount: '0',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...fields,
  };
}

export function buy(date: string, instrumentId: string, quantity: string, price: string): Transaction {
  const amount = (Number(quantity) * Number(price)).toString();
  return tx('BUY', date, { instrumentId, quantity, price, amount });
}

export function idGen(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}
