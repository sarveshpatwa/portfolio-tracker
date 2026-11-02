import { useState, useSyncExternalStore } from 'react';
import { linkPriceService, type LinkState } from '../../application/linkPriceService';
import { parsePriceLink } from '../../domain/pricing/priceLink';
import type { DatedPrice } from '../../domain/pricing/prices';
import type { Instrument } from '../../domain/types';
import { assetRepo } from '../../data/repositories/assetRepo';
import { href } from '../../app/routes';
import { Field } from './Field';
import { formatTradingDate } from './priceLabels';

/** Live fetch state of one price-linked asset. */
export function useLinkState(instrumentId: string): LinkState {
  useSyncExternalStore(linkPriceService.subscribe, linkPriceService.getVersion, linkPriceService.getVersion);
  return linkPriceService.stateOf(instrumentId);
}

/** One-line status under a price-linked holding. */
export function LinkStatusLine({ instrument, price }: { instrument: Instrument; price: DatedPrice | undefined }) {
  const state = useLinkState(instrument.id);
  const last = price ? `${price.source === 'manual' ? 'typed' : 'Vanguard'} price of ${formatTradingDate(price.date)}` : 'no price yet';
  if (!state.relaySet) {
    return (
      <span className="small warn-text">
        Price link set — <a href={href.settings()}>set up the relay</a> · {last}
      </span>
    );
  }
  if (state.fetching) return <span className="small muted">Fetching Vanguard price…</span>;
  if (state.error) {
    return (
      <span className="small warn-text" title={state.error}>
        Couldn’t fetch the Vanguard price · showing {last}
      </span>
    );
  }
  return <span className="small muted">{price ? `${price.source === 'manual' ? 'Typed price' : 'Vanguard price'} · ${formatTradingDate(price.date)}` : 'Waiting for first price…'}</span>;
}

/** Asset options: add, change or remove a price link; fetch now; open the Vanguard page. */
export function PriceLinkEditor({ instrument }: { instrument: Instrument }) {
  const state = useLinkState(instrument.id);
  const [text, setText] = useState(instrument.priceLink?.url || instrument.priceLink?.fundId || '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = instrument.priceLink;

  const save = async () => {
    setSaved(false);
    if (!text.trim()) {
      await assetRepo.setPriceLink(instrument.id, undefined);
      setError(null);
      setSaved(true);
      void linkPriceService.runDue(); // forgets the old fetch status
      return;
    }
    const r = parsePriceLink(text);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await assetRepo.setPriceLink(instrument.id, r.link);
      setSaved(true);
      await linkPriceService.runDue({ force: true, only: instrument.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Saving failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack-tight">
      <Field
        label="Daily price from Vanguard (page link or fund number)"
        error={error ?? undefined}
        hint={current ? `Fund ${current.fundId}. Clear the box and save to stop fetching.` : 'Optional. Typed prices keep working and win on their date.'}
      >
        {(p) => (
          <input
            {...p}
            className="input"
            inputMode="url"
            autoComplete="off"
            value={text}
            placeholder="https://investor.vanguard.com/…/overview/0066…"
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
          />
        )}
      </Field>
      <div className="row-start wrap">
        <button type="button" className="btn btn-small btn-outline" disabled={busy} onClick={() => void save()}>
          {text.trim() ? 'Save link' : current ? 'Remove link' : 'Save link'}
        </button>
        {current && (
          <button
            type="button"
            className="btn btn-small btn-outline"
            disabled={busy || state.fetching || !state.relaySet}
            onClick={() => void linkPriceService.runDue({ force: true, only: instrument.id })}
          >
            {state.fetching ? 'Fetching…' : 'Fetch now'}
          </button>
        )}
        {current?.url && (
          <a className="btn btn-small btn-ghost" href={current.url} target="_blank" rel="noopener noreferrer">
            Open Vanguard page ↗
          </a>
        )}
      </div>
      <p className="small" role="status">
        {saved && !current && 'Link removed.'}
        {saved && current && !state.fetching && !state.error && 'Saved.'}
        {current && state.error && <span className="warn-text">Last fetch: {state.error}</span>}
        {current && !state.relaySet && (
          <span className="warn-text">
            {' '}
            Fetching needs the price relay — <a href={href.settings()}>Settings → Price links</a>.
          </span>
        )}
      </p>
    </section>
  );
}
