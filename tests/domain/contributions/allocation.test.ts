import { describe, expect, it } from 'vitest';
import { describeIssue, planInEffect, validateAllocation } from '../../../src/domain/contributions/allocation';
import type { AllocationPlan } from '../../../src/domain/types';

const t = (instrumentId: string, pct: string) => ({ instrumentId, pct });

describe('validateAllocation', () => {
  it('accepts targets totalling 100%', () => {
    const r = validateAllocation([t('VTI', '40'), t('BND', '35'), t('FUNDA', '25')]);
    expect(r.ok).toBe(true);
    expect(r.total.toString()).toBe('100');
  });

  it('accepts thirds within tolerance', () => {
    expect(validateAllocation([t('A', '33.3333'), t('B', '33.3333'), t('C', '33.3334')]).ok).toBe(true);
  });

  it('warns when the total is not 100% with a helpful message', () => {
    const r = validateAllocation([t('VTI', '40'), t('BND', '35'), t('FUNDA', '20')]);
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.kind === 'total-not-100');
    expect(issue && describeIssue(issue)).toBe('Total is 95% — add 5% more.');

    const over = validateAllocation([t('VTI', '60'), t('BND', '50')]);
    const overIssue = over.issues.find((i) => i.kind === 'total-not-100');
    expect(overIssue && describeIssue(overIssue)).toBe('Total is 110% — remove 10%.');
  });

  it('reports empty, negative, invalid and duplicate entries', () => {
    expect(validateAllocation([]).issues.map((i) => i.kind)).toEqual(['empty']);
    const kinds = validateAllocation([t('A', '-10'), t('A', '60'), t('B', 'x')]).issues.map((i) => i.kind);
    expect(kinds).toContain('negative');
    expect(kinds).toContain('duplicate');
    expect(kinds).toContain('invalid-number');
  });
});

describe('planInEffect', () => {
  const plan = (version: number, effectiveFrom: string): AllocationPlan => ({
    id: `v${version}`,
    portfolioId: 'p1',
    version,
    effectiveFrom,
    targets: [],
    createdAt: '',
  });
  const plans = [plan(1, '2025-01-06'), plan(2, '2025-06-01'), plan(3, '2026-03-01'), plan(4, '2026-03-01')];

  it('picks the latest version effective on the date', () => {
    expect(planInEffect(plans, '2025-01-05')).toBeUndefined();
    expect(planInEffect(plans, '2025-01-06')?.id).toBe('v1');
    expect(planInEffect(plans, '2025-12-31')?.id).toBe('v2');
    expect(planInEffect(plans, '2026-10-30')?.id).toBe('v4');
  });
});
