/**
 * Dec — an immutable fixed-point decimal for money, prices and share quantities.
 *
 * Why not plain `number`? Binary floating point cannot represent most decimal
 * fractions exactly (0.1 + 0.2 = 0.30000000000000004). Over hundreds of
 * contributions those errors accumulate into visible cents. Dec stores every
 * value as a BigInt count of 10^-12 units, so add/subtract are always exact,
 * and multiply/divide round only at the 12th decimal place — far below the
 * cent (2 dp), share (6 dp) and price (4 dp) precision the app displays.
 *
 * Values are persisted as strings (see `toString`) so IndexedDB round-trips
 * them without loss.
 */

const DP = 12;
const SCALE = 10n ** BigInt(DP);

export type DecInput = Dec | string | number | bigint;

export class Dec {
  /** Raw value in units of 10^-12. */
  private readonly units: bigint;

  private constructor(units: bigint) {
    this.units = units;
  }

  static readonly ZERO = new Dec(0n);
  static readonly ONE = new Dec(SCALE);
  static readonly HUNDRED = new Dec(100n * SCALE);

  static from(value: DecInput): Dec {
    if (value instanceof Dec) return value;
    if (typeof value === 'bigint') return new Dec(value * SCALE);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
      // toFixed avoids exponent notation (1e-7) and fixes the digits we keep.
      return Dec.parse(value.toFixed(DP));
    }
    return Dec.parse(value);
  }

  /** Parses "123", "-0.5", "1,234.56", "$1,000" (commas and a leading $ are ignored). */
  static parse(text: string): Dec {
    const cleaned = text.trim().replace(/[,\s]/g, '').replace(/^(-?)\$/, '$1');
    const match = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(cleaned);
    if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
      throw new SyntaxError(`Not a decimal number: "${text}"`);
    }
    const sign = match[1] === '-' ? -1n : 1n;
    const whole = BigInt(match[2] || '0');
    const fracDigits = match[3] ?? '';
    // Digits beyond 12 dp are rounded half away from zero.
    const kept = fracDigits.slice(0, DP).padEnd(DP, '0');
    let units = whole * SCALE + BigInt(kept);
    const next = fracDigits.charAt(DP);
    if (next !== '' && next >= '5') units += 1n;
    return new Dec(sign * units);
  }

  /** Parses user input; returns null instead of throwing. */
  static tryParse(text: string): Dec | null {
    try {
      return Dec.parse(text);
    } catch {
      return null;
    }
  }

  static sum(values: Iterable<DecInput>): Dec {
    let total = 0n;
    for (const v of values) total += Dec.from(v).units;
    return new Dec(total);
  }

  static max(a: DecInput, b: DecInput): Dec {
    const x = Dec.from(a);
    const y = Dec.from(b);
    return x.gte(y) ? x : y;
  }

  static min(a: DecInput, b: DecInput): Dec {
    const x = Dec.from(a);
    const y = Dec.from(b);
    return x.lte(y) ? x : y;
  }

  add(other: DecInput): Dec {
    return new Dec(this.units + Dec.from(other).units);
  }

  sub(other: DecInput): Dec {
    return new Dec(this.units - Dec.from(other).units);
  }

  /** (a × b), rounded half away from zero at 12 dp. */
  mul(other: DecInput): Dec {
    return new Dec(divRound(this.units * Dec.from(other).units, SCALE));
  }

  /** (a ÷ b), rounded half away from zero at 12 dp. Throws on division by zero. */
  div(other: DecInput): Dec {
    const d = Dec.from(other).units;
    if (d === 0n) throw new RangeError('Division by zero');
    return new Dec(divRound(this.units * SCALE, d));
  }

  neg(): Dec {
    return new Dec(-this.units);
  }

  abs(): Dec {
    return this.units < 0n ? this.neg() : this;
  }

  cmp(other: DecInput): -1 | 0 | 1 {
    const o = Dec.from(other).units;
    return this.units < o ? -1 : this.units > o ? 1 : 0;
  }

  eq(other: DecInput): boolean {
    return this.cmp(other) === 0;
  }
  lt(other: DecInput): boolean {
    return this.cmp(other) < 0;
  }
  lte(other: DecInput): boolean {
    return this.cmp(other) <= 0;
  }
  gt(other: DecInput): boolean {
    return this.cmp(other) > 0;
  }
  gte(other: DecInput): boolean {
    return this.cmp(other) >= 0;
  }
  isZero(): boolean {
    return this.units === 0n;
  }
  isNegative(): boolean {
    return this.units < 0n;
  }
  isPositive(): boolean {
    return this.units > 0n;
  }

  /**
   * Rounds DOWN (toward −∞) to `dp` decimal places.
   * Used when buying: 1.3656079 shares becomes 1.365607 so we never spend
   * more cash than was allocated.
   */
  floorTo(dp: number): Dec {
    const step = stepFor(dp);
    let q = this.units / step; // BigInt division truncates toward zero
    if (this.units < 0n && this.units % step !== 0n) q -= 1n;
    return new Dec(q * step);
  }

  /** Rounds half away from zero to `dp` decimal places (used for display and cents). */
  roundTo(dp: number): Dec {
    const step = stepFor(dp);
    return new Dec(divRound(this.units, step) * step);
  }

  /** Fixed number of decimals, rounded half away from zero: Dec.from('2.005').toFixed(2) === '2.01'. */
  toFixed(dp: number): string {
    const rounded = this.roundTo(dp).units;
    const negative = rounded < 0n;
    const abs = negative ? -rounded : rounded;
    const whole = abs / SCALE;
    const frac = (abs % SCALE).toString().padStart(DP, '0').slice(0, dp);
    const body = dp > 0 ? `${whole}.${frac}` : `${whole}`;
    return negative ? `-${body}` : body;
  }

  /** Shortest exact representation, e.g. "1.5", "-0.000001", "42". Used for storage. */
  toString(): string {
    const negative = this.units < 0n;
    const abs = negative ? -this.units : this.units;
    const whole = abs / SCALE;
    const frac = (abs % SCALE).toString().padStart(DP, '0').replace(/0+$/, '');
    const body = frac ? `${whole}.${frac}` : `${whole}`;
    return negative ? `-${body}` : body;
  }

  toJSON(): string {
    return this.toString();
  }

  /** Lossy conversion for charts and statistics only — never for ledger math. */
  toNumber(): number {
    return Number(this.toString());
  }
}

/** Shorthand: d('12.50') */
export const d = (value: DecInput): Dec => Dec.from(value);

function stepFor(dp: number): bigint {
  if (!Number.isInteger(dp) || dp < 0 || dp > DP) throw new RangeError(`dp must be 0–${DP}`);
  return 10n ** BigInt(DP - dp);
}

/** Integer division rounding half away from zero. */
function divRound(n: bigint, divisor: bigint): bigint {
  const negative = n < 0n !== divisor < 0n;
  const an = n < 0n ? -n : n;
  const ad = divisor < 0n ? -divisor : divisor;
  const q = (an + ad / 2n) / ad;
  return negative ? -q : q;
}
