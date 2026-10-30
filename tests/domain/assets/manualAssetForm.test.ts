import { describe, expect, it } from 'vitest';
import { parseManualAssetForm, parsePriceUpdate, type ManualAssetFormInput } from '../../../src/domain/assets/manualAssetForm';

const base: ManualAssetFormInput = {
  name: 'Private Fund A',
  assetClass: 'fund',
  price: '18.80',
  priceDate: '2026-10-17',
  reminderDays: '14',
  startQuantity: '',
  startCost: '',
  startDate: '',
};
const today = '2026-10-30';

describe('parseManualAssetForm', () => {
  it('accepts a valid asset without a starting position', () => {
    const r = parseManualAssetForm(base, today);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.price.toString()).toBe('18.8');
      expect(r.value.reminderDays).toBe(14);
      expect(r.value.starting).toBeUndefined();
    }
  });

  it('defaults starting cost to the price and date to the price date', () => {
    const r = parseManualAssetForm({ ...base, startQuantity: '151.3441' }, today);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.starting?.quantity.toString()).toBe('151.3441');
      expect(r.value.starting?.costPerUnit.toString()).toBe('18.8');
      expect(r.value.starting?.date).toBe('2026-10-17');
    }
  });

  it('uses an explicit cost and purchase date', () => {
    const r = parseManualAssetForm({ ...base, startQuantity: '100', startCost: '$14.50', startDate: '2025-01-06' }, today);
    expect(r.ok && r.value.starting?.costPerUnit.toString()).toBe('14.5');
    expect(r.ok && r.value.starting?.date).toBe('2025-01-06');
  });

  it('reports every field problem at once', () => {
    const r = parseManualAssetForm(
      { ...base, name: '  ', price: '0', priceDate: '2026-11-01', startQuantity: '-1', startCost: 'abc', startDate: '2026-02-30' },
      today,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(['name', 'price', 'priceDate', 'startCost', 'startDate', 'startQuantity']);
      expect(r.errors.priceDate).toBe('The date can’t be in the future.');
    }
  });

  it('rejects duplicate names in the same portfolio (case-insensitive)', () => {
    const r = parseManualAssetForm(base, today, ['private fund a']);
    expect(!r.ok && r.errors.name).toBe('This portfolio already has an asset with that name.');
  });

  it('allows no reminder', () => {
    const r = parseManualAssetForm({ ...base, reminderDays: '' }, today);
    expect(r.ok && r.value.reminderDays).toBeUndefined();
  });
});

describe('parsePriceUpdate', () => {
  it('validates price and date', () => {
    const ok = parsePriceUpdate('19.10', '2026-10-30', today);
    expect(ok.ok && ok.price.toString()).toBe('19.1');
    const bad = parsePriceUpdate('', '2026-10-31', today);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['date', 'price']);
  });
});
