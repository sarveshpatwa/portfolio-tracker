import { describe, expect, it } from 'vitest';
import { parseMarketStart } from '../../../src/domain/assets/marketAssetForm';
import type { PricePoint } from '../../../src/domain/types';

const history: PricePoint[] = [
  { instrumentId: 'VTI', date: '2025-01-03', close: '290.10', source: 'market' },
  { instrumentId: 'VTI', date: '2025-01-06', close: '291.75', source: 'market' },
];
const today = '2026-10-30';

describe('parseMarketStart', () => {
  it('allows no starting position', () => {
    expect(parseMarketStart({ units: '', cost: '', date: '' }, today, history)).toEqual({ ok: true, value: null });
  });

  it('uses the closing price on the purchase date when cost is blank', () => {
    const r = parseMarketStart({ units: '10', cost: '', date: '2025-01-06' }, today, history);
    expect(r.ok && r.value?.costPerUnit.toString()).toBe('291.75');
    expect(r.ok && r.value?.costFromHistory).toBe(true);
  });

  it('falls back to the previous trading day (weekend purchase date)', () => {
    const r = parseMarketStart({ units: '10', cost: '', date: '2025-01-05' }, today, history);
    expect(r.ok && r.value?.costPerUnit.toString()).toBe('290.1');
  });

  it('uses an explicit cost and defaults the date to today', () => {
    const r = parseMarketStart({ units: '2.5', cost: '300', date: '' }, today, history);
    expect(r.ok && r.value?.date).toBe(today);
    expect(r.ok && r.value?.costFromHistory).toBe(false);
  });

  it('asks for a cost when history does not reach back that far', () => {
    const r = parseMarketStart({ units: '10', cost: '', date: '2024-06-01' }, today, history);
    expect(!r.ok && r.errors.cost).toBe('No price history for that date. Enter the cost per share.');
  });

  it('validates units and dates', () => {
    const r = parseMarketStart({ units: '0', cost: '', date: '2026-12-01' }, today, history);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['date', 'units']);
  });
});
