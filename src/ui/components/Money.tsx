import type { Dec } from '../../domain/money/decimal';
import { formatPct, formatSignedUsd } from '../../domain/money/format';

/** "+$1,940.18 · +17.6%" coloured green/red. Colour is never the only cue: the sign is always shown. */
export function Gain({ amount, pct, className = '' }: { amount: Dec; pct: Dec | null; className?: string }) {
  const tone = amount.roundTo(2).isZero() ? '' : amount.isNegative() ? 'loss' : 'gain';
  return (
    <span className={`${tone} ${className}`.trim()}>
      {formatSignedUsd(amount)}
      {pct && ` · ${formatPct(pct)}`}
    </span>
  );
}
