import { describe, expect, it } from 'vitest';
import { isMarketOpen, latestCompletedTradingDay, marketSession, nyClock } from '../../../src/domain/market/marketHours';
import { checkCredits, chunk, creditsUsedToday, effectiveRefreshMinutes, emptyUsage, spendCredits } from '../../../src/domain/market/budget';
import { historyRequest, lastFinalClose } from '../../../src/domain/market/history';
import type { PricePoint } from '../../../src/domain/types';

const at = (iso: string) => new Date(iso);

describe('market hours (New York time, DST-safe)', () => {
  it('opens at 9:30 ET in US summer time (13:30 UTC)', () => {
    expect(marketSession(at('2026-10-30T13:29:00Z'))).toBe('pre-market');
    expect(marketSession(at('2026-10-30T13:30:00Z'))).toBe('open');
    expect(marketSession(at('2026-10-30T19:59:00Z'))).toBe('open');
    expect(marketSession(at('2026-10-30T20:00:00Z'))).toBe('after-close');
  });

  it('opens at 9:30 ET in US winter time (14:30 UTC) after DST ends on Nov 1', () => {
    expect(isMarketOpen(at('2026-11-02T14:29:00Z'))).toBe(false);
    expect(isMarketOpen(at('2026-11-02T14:30:00Z'))).toBe(true);
    expect(nyClock(at('2026-11-02T14:30:00Z'))).toEqual({ date: '2026-11-02', minutes: 570 });
  });

  it('is closed on weekends and holidays', () => {
    expect(marketSession(at('2026-10-31T15:00:00Z'))).toBe('closed-day'); // Saturday
    expect(marketSession(at('2026-11-26T15:00:00Z'))).toBe('closed-day'); // Thanksgiving
    expect(marketSession(at('2026-11-27T15:00:00Z'))).toBe('open');
  });

  it('knows the latest final close', () => {
    expect(latestCompletedTradingDay(at('2026-10-30T20:14:00Z'))).toBe('2026-10-29'); // 16:14 ET: not final yet
    expect(latestCompletedTradingDay(at('2026-10-30T20:15:00Z'))).toBe('2026-10-30');
    expect(latestCompletedTradingDay(at('2026-10-31T12:00:00Z'))).toBe('2026-10-30'); // Saturday
    expect(latestCompletedTradingDay(at('2026-11-02T10:00:00Z'))).toBe('2026-10-30'); // Monday 5 am ET
    // 01:00 UTC Oct 31 is still Oct 30 evening in New York (after the close).
    expect(latestCompletedTradingDay(at('2026-10-31T01:00:00Z'))).toBe('2026-10-30');
  });
});

describe('refresh budget', () => {
  it('keeps the preferred interval when the budget allows', () => {
    expect(effectiveRefreshMinutes(15, 10)).toEqual({ minutes: 10, limited: false });
    expect(effectiveRefreshMinutes(0, 10)).toEqual({ minutes: 10, limited: false });
  });

  it('slows down automatically with many symbols', () => {
    expect(effectiveRefreshMinutes(60, 10)).toEqual({ minutes: 36, limited: true });
    expect(effectiveRefreshMinutes(16, 5)).toEqual({ minutes: 10, limited: true });
    expect(effectiveRefreshMinutes(800, 10)).toEqual({ minutes: 390, limited: true });
  });

  it('splits symbols into per-minute batches', () => {
    expect(chunk(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });
});

describe('credit limiter', () => {
  const t0 = Date.parse('2026-10-30T15:00:00Z');

  it('allows 8 per minute, then says how long to wait', () => {
    const u = spendCredits(emptyUsage(), 8, t0);
    expect(checkCredits(u, 1, t0 + 1000)).toEqual({ ok: false, reason: 'minute', waitMs: 59_000 });
    expect(checkCredits(u, 1, t0 + 60_000)).toEqual({ ok: true });
    expect(checkCredits(emptyUsage(), 9, t0)).toEqual({ ok: false, reason: 'minute', waitMs: 60_000 });
  });

  it('stops at 800 per day and resets at midnight UTC', () => {
    const u = { day: '2026-10-30', used: 800, recent: [] };
    const r = checkCredits(u, 1, t0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('day');
    expect(creditsUsedToday(u, Date.parse('2026-10-31T00:00:01Z'))).toBe(0);
    expect(checkCredits(u, 1, Date.parse('2026-10-31T00:00:01Z'))).toEqual({ ok: true });
  });
});

describe('history requests', () => {
  const p = (date: string, intraday = false): PricePoint => ({ instrumentId: 'VTI', date, close: '1', source: 'market', ...(intraday ? { intraday } : {}) });

  it('downloads full history the first time', () => {
    expect(historyRequest([], '2026-10-30')).toEqual({ kind: 'full' });
  });

  it('tops up from the day after the last final close, ignoring intraday points', () => {
    const points = [p('2026-10-27'), p('2026-10-28'), p('2026-10-29', true)];
    expect(lastFinalClose(points)).toBe('2026-10-28');
    expect(historyRequest(points, '2026-10-30')).toEqual({ kind: 'since', startDate: '2026-10-29' });
  });

  it('does nothing when up to date', () => {
    expect(historyRequest([p('2026-10-30')], '2026-10-30')).toBeNull();
  });

  it('ignores manual prices', () => {
    expect(historyRequest([{ instrumentId: 'VTI', date: '2026-10-30', close: '1', source: 'manual' }], '2026-10-30')).toEqual({ kind: 'full' });
  });
});
