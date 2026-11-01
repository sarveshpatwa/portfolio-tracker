import { describe, expect, it } from 'vitest';
import { d } from '../../../src/domain/money/decimal';
import { quoteToPoint } from '../../../src/application/priceService';

const q = (date: string, marketOpen: boolean) => ({
  symbol: 'VTI', price: d('292.91'), date, observedAt: Date.parse('2026-10-30T18:00:00Z'), marketOpen, currency: 'USD',
});

describe('quoteToPoint', () => {
  it('stores a quote during the session as an intraday point for that day', () => {
    const p = quoteToPoint('i1', q('2026-10-30', true), new Date('2026-10-30T18:00:00Z'));
    expect(p).toEqual({ instrumentId: 'i1', date: '2026-10-30', close: '292.91', source: 'market', updatedAt: '2026-10-30T18:00:00.000Z', intraday: true });
  });

  it('stores a quote after 16:15 ET as the final close', () => {
    const p = quoteToPoint('i1', q('2026-10-30', false), new Date('2026-10-30T21:00:00Z'));
    expect(p.intraday).toBeUndefined();
  });

  it('keeps it intraday right after the bell until the close is final', () => {
    const p = quoteToPoint('i1', q('2026-10-30', false), new Date('2026-10-30T20:05:00Z'));
    expect(p.intraday).toBe(true);
  });
});
