/**
 * Allocation presets: "put 40% of each contribution into VTI, 35% into BND…".
 *
 * A plan is valid when:
 *  - it has at least one target,
 *  - every percentage is a number ≥ 0 (0 is allowed and simply skipped),
 *  - no asset appears twice,
 *  - the percentages total exactly 100 (to 4 decimal places, so thirds like
 *    33.3333 + 33.3333 + 33.3334 work).
 *
 * Validation returns every issue at once so the form can show them together.
 */

import { Dec } from '../money/decimal';
import type { AllocationPlan, AllocationTarget, Id } from '../types';
import type { IsoDate } from '../calendar/dates';

export type AllocationIssue =
  | { kind: 'empty' }
  | { kind: 'invalid-number'; instrumentId: Id }
  | { kind: 'negative'; instrumentId: Id }
  | { kind: 'duplicate'; instrumentId: Id }
  | { kind: 'total-not-100'; total: Dec; difference: Dec };

export interface AllocationCheck {
  ok: boolean;
  total: Dec;
  issues: AllocationIssue[];
}

const TOLERANCE = Dec.from('0.0001');

export function validateAllocation(targets: readonly AllocationTarget[]): AllocationCheck {
  const issues: AllocationIssue[] = [];
  if (targets.length === 0) issues.push({ kind: 'empty' });

  const seen = new Set<Id>();
  let total = Dec.ZERO;
  for (const t of targets) {
    if (seen.has(t.instrumentId)) issues.push({ kind: 'duplicate', instrumentId: t.instrumentId });
    seen.add(t.instrumentId);

    const pct = Dec.tryParse(t.pct);
    if (!pct) {
      issues.push({ kind: 'invalid-number', instrumentId: t.instrumentId });
      continue;
    }
    if (pct.isNegative()) issues.push({ kind: 'negative', instrumentId: t.instrumentId });
    total = total.add(pct);
  }

  const difference = Dec.HUNDRED.sub(total);
  if (targets.length > 0 && difference.abs().gt(TOLERANCE)) {
    issues.push({ kind: 'total-not-100', total, difference });
  }
  return { ok: issues.length === 0, total, issues };
}

/** Plain-language message for an issue, e.g. "Total is 95% — add 5% more". */
export function describeIssue(issue: AllocationIssue, nameOf: (id: Id) => string = (id) => id): string {
  switch (issue.kind) {
    case 'empty':
      return 'Add at least one asset to the allocation.';
    case 'invalid-number':
      return `${nameOf(issue.instrumentId)}: enter a number.`;
    case 'negative':
      return `${nameOf(issue.instrumentId)}: percentage can't be negative.`;
    case 'duplicate':
      return `${nameOf(issue.instrumentId)} is listed twice.`;
    case 'total-not-100': {
      const diff = issue.difference.abs().roundTo(4).toString();
      return issue.difference.isPositive()
        ? `Total is ${issue.total.roundTo(4)}% — add ${diff}% more.`
        : `Total is ${issue.total.roundTo(4)}% — remove ${diff}%.`;
    }
  }
}

/**
 * The plan in force on `date`: the highest version whose effectiveFrom is on
 * or before that date. Returns undefined if no plan existed yet.
 */
export function planInEffect(plans: readonly AllocationPlan[], date: IsoDate): AllocationPlan | undefined {
  let best: AllocationPlan | undefined;
  for (const p of plans) {
    if (p.effectiveFrom > date) continue;
    if (
      !best ||
      p.effectiveFrom > best.effectiveFrom ||
      (p.effectiveFrom === best.effectiveFrom && p.version > best.version)
    ) {
      best = p;
    }
  }
  return best;
}
