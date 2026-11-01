/**
 * Staying inside the free Twelve Data plan: 8 credits per minute, 800 per day.
 * A quote or a daily-history request costs 1 credit per symbol; a symbol
 * search costs 1 credit.
 *
 * Refresh interval during market hours (390 minutes):
 *   quoteBudget  = 800 − 100 reserved for history top-ups and searches
 *   refreshes    = floor(quoteBudget ÷ symbols)
 *   needed       = ceil(390 ÷ refreshes)         minutes between refreshes
 *   minutes      = max(preferred, needed, ceil(symbols ÷ 8))
 * e.g. 15 symbols → 46 refreshes → every 9 min at most; preferred 10 → 10.
 *      60 symbols → 11 refreshes → every 36 min.
 *
 * The credit limiter tracks usage locally (sliding 60-second window + a daily
 * counter reset at 00:00 UTC) so the app slows down BEFORE the API refuses.
 */

export interface Plan {
  perMinute: number;
  perDay: number;
}

export const FREE_PLAN: Plan = { perMinute: 8, perDay: 800 };
export const RESERVED_CREDITS = 100;
export const MARKET_MINUTES = 390;

export function effectiveRefreshMinutes(
  symbolCount: number,
  preferredMinutes: number,
  plan: Plan = FREE_PLAN,
): { minutes: number; limited: boolean } {
  if (symbolCount <= 0) return { minutes: preferredMinutes, limited: false };
  const refreshes = Math.floor((plan.perDay - RESERVED_CREDITS) / symbolCount);
  if (refreshes < 1) return { minutes: MARKET_MINUTES, limited: true };
  const needed = Math.ceil(MARKET_MINUTES / refreshes);
  const minutes = Math.max(preferredMinutes, needed, Math.ceil(symbolCount / plan.perMinute));
  return { minutes, limited: minutes > preferredMinutes };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError('size must be ≥ 1');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- Credit limiter -------------------------------------------------------

export interface CreditUsage {
  /** UTC date the counter belongs to. */
  day: string;
  used: number;
  /** Timestamps (ms) of credits spent in the last minute. */
  recent: number[];
}

export const emptyUsage = (): CreditUsage => ({ day: '', used: 0, recent: [] });

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

function normalize(u: CreditUsage, now: number): CreditUsage {
  const day = utcDay(now);
  return {
    day,
    used: u.day === day ? u.used : 0,
    recent: u.recent.filter((t) => now - t < 60_000),
  };
}

export type SpendCheck = { ok: true } | { ok: false; reason: 'minute' | 'day'; waitMs: number };

export function checkCredits(u: CreditUsage, credits: number, now: number, plan: Plan = FREE_PLAN): SpendCheck {
  const n = normalize(u, now);
  if (n.used + credits > plan.perDay) {
    const midnight = Date.parse(`${n.day}T00:00:00Z`) + 86_400_000;
    return { ok: false, reason: 'day', waitMs: midnight - now };
  }
  if (credits > plan.perMinute) return { ok: false, reason: 'minute', waitMs: 60_000 };
  const overflow = n.recent.length + credits - plan.perMinute;
  if (overflow > 0) {
    const sorted = [...n.recent].sort((a, b) => a - b);
    return { ok: false, reason: 'minute', waitMs: sorted[overflow - 1]! + 60_000 - now };
  }
  return { ok: true };
}

export function spendCredits(u: CreditUsage, credits: number, now: number): CreditUsage {
  const n = normalize(u, now);
  return { day: n.day, used: n.used + credits, recent: [...n.recent, ...Array.from({ length: credits }, () => now)] };
}

export function creditsUsedToday(u: CreditUsage, now: number): number {
  return normalize(u, now).used;
}
