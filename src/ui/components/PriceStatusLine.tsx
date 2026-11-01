import { usePriceStatus } from '../../application/usePriceStatus';
import { priceService } from '../../application/priceService';
import { describeAge } from '../../domain/pricing/prices';
import { href } from '../../app/routes';
import { formatEt } from './priceLabels';

const SESSION_TEXT = {
  open: 'Market open',
  'pre-market': 'Market opens 9:30 ET',
  'after-close': 'Market closed',
  'closed-day': 'Market closed today',
} as const;

/** One line: market state, when prices last updated, and a Refresh button. Hidden when no tickers are held. */
export function PriceStatusLine() {
  const s = usePriceStatus();
  if (s.state === 'no-key') {
    if (s.symbols === 0) return null;
    return (
      <p className="small warn-text price-status">
        <span>Live prices are off.</span> <a href={href.settings()}>Add API key ›</a>
      </p>
    );
  }
  if (s.symbols === 0) return null;

  const updated = s.lastQuoteAt
    ? Date.now() - s.lastQuoteAt < 3_600_000
      ? `updated ${Math.max(1, Math.round((Date.now() - s.lastQuoteAt) / 60_000))} min ago`
      : `updated ${formatEt(s.lastQuoteAt)}${Date.now() - s.lastQuoteAt > 86_400_000 ? ` (${describeAge(Math.floor((Date.now() - s.lastQuoteAt) / 86_400_000))})` : ''}`
    : 'not refreshed yet';

  return (
    <div className="price-status" role="status" aria-live="polite">
      <p className={`small ${s.state === 'error' || s.state === 'waiting' ? 'warn-text' : 'muted'}`}>
        {s.state === 'refreshing' ? 'Updating prices…' : `${SESSION_TEXT[s.session]} · prices ${updated}`}
        {s.message && s.state !== 'refreshing' && <span className="block">{s.message}</span>}
      </p>
      <button className="btn btn-small btn-outline" disabled={s.state === 'refreshing' || s.state === 'waiting'} onClick={() => void priceService.tick({ forceQuotes: true })}>
        Refresh
      </button>
    </div>
  );
}
