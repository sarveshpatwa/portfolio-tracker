import { describe, expect, it } from 'vitest';
import { Dec, d } from '../../../src/domain/money/decimal';
import { formatPct, formatQty, formatSignedUsd, formatUsd } from '../../../src/domain/money/format';

describe('Dec arithmetic', () => {
  it('adds decimals exactly (no float error)', () => {
    expect(d('0.1').add('0.2').toString()).toBe('0.3');
    expect(Dec.sum(Array.from({ length: 1000 }, () => '0.01')).toString()).toBe('10');
  });

  it('parses user-style input', () => {
    expect(d('$1,234.50').toString()).toBe('1234.5');
    expect(d('-$12').toString()).toBe('-12');
    expect(d(' .5 ').toString()).toBe('0.5');
    expect(Dec.tryParse('abc')).toBeNull();
    expect(Dec.tryParse('')).toBeNull();
    expect(Dec.tryParse('1.2.3')).toBeNull();
  });

  it('converts numbers without exponent artefacts', () => {
    expect(d(1e-7).toString()).toBe('0.0000001');
    expect(d(292.91).toString()).toBe('292.91');
  });

  it('multiplies and divides with 12-dp precision', () => {
    expect(d('19.8743').mul('292.91').toString()).toBe('5821.381213');
    expect(d('1').div('3').toString()).toBe('0.333333333333');
    expect(d('2').div('3').toString()).toBe('0.666666666667');
    expect(() => d('1').div(0)).toThrow();
  });

  it('floors toward negative infinity', () => {
    expect(d('1.3656079').floorTo(6).toString()).toBe('1.365607');
    expect(d('-1.0000001').floorTo(6).toString()).toBe('-1.000001');
    expect(d('7.99').floorTo(0).toString()).toBe('7');
  });

  it('rounds half away from zero', () => {
    expect(d('2.005').toFixed(2)).toBe('2.01');
    expect(d('-2.005').toFixed(2)).toBe('-2.01');
    expect(d('2.004').toFixed(2)).toBe('2.00');
    expect(d('5').toFixed(2)).toBe('5.00');
  });

  it('compares', () => {
    expect(d('1.10').eq('1.1')).toBe(true);
    expect(d('1').lt('1.000000000001')).toBe(true);
    expect(Dec.max('3', '2').toString()).toBe('3');
  });
});

describe('formatting', () => {
  it('formats dollars', () => {
    expect(formatUsd('12940.175')).toBe('$12,940.18');
    expect(formatUsd('-138.9')).toBe('−$138.90');
    expect(formatUsd('-0.001')).toBe('$0.00');
    expect(formatSignedUsd('1940.18')).toBe('+$1,940.18');
    expect(formatSignedUsd('-3.4')).toBe('−$3.40');
  });

  it('formats percentages and quantities', () => {
    expect(formatPct('0.176')).toBe('+17.6%');
    expect(formatPct('-0.046')).toBe('−4.6%');
    expect(formatPct('0.45', 1, false)).toBe('45.0%');
    expect(formatQty('19.874300')).toBe('19.8743');
    expect(formatQty('5250')).toBe('5,250');
    expect(formatQty('-1234567.5')).toBe('-1,234,567.5');
  });
});
