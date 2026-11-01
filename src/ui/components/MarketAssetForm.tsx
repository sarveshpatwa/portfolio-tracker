import { useState, type FormEvent } from 'react';
import type { AssetRow } from '../../application/portfolioQueries';
import { priceService, quoteToPoint } from '../../application/priceService';
import { parseMarketStart, type MarketStartErrors, type MarketStartInput } from '../../domain/assets/marketAssetForm';
import { todayLocal } from '../../domain/calendar/dates';
import { Dec } from '../../domain/money/decimal';
import { formatUsd } from '../../domain/money/format';
import { ASSET_CLASS_LABELS, type AssetClass, type Portfolio, type PricePoint } from '../../domain/types';
import type { Quote, SymbolMatch } from '../../data/providers/marketData';
import { assetRepo } from '../../data/repositories/assetRepo';
import { href, navigate } from '../../app/routes';
import { Field } from './Field';
import { marketPriceLabel } from './priceLabels';

const withoutInstrument = ({ instrumentId: _id, ...rest }: PricePoint): Omit<PricePoint, 'instrumentId'> => rest;

const CLASSES: AssetClass[] = ['etf', 'stock', 'bond', 'fund', 'other'];

export function MarketAssetForm({ portfolio, rows }: { portfolio: Portfolio; rows: AssetRow[] }) {
  const today = todayLocal();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SymbolMatch | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [assetClass, setAssetClass] = useState<AssetClass>('etf');
  const [start, setStart] = useState<MarketStartInput>({ units: '', cost: '', date: '' });
  const [errors, setErrors] = useState<MarketStartErrors & { form?: string }>({});
  const [busy, setBusy] = useState(false);

  const held = new Set(rows.map((r) => r.instrument.symbol).filter(Boolean));

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return setSearchError('Type a ticker or a company / fund name.');
    setSearching(true);
    setSearchError(null);
    try {
      const found = await priceService.search(query);
      setResults(found);
      if (found.length === 0) setSearchError('No US-listed match. Check the ticker, or use Manual price for unlisted assets.');
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setSearching(false);
    }
  };

  const choose = async (m: SymbolMatch) => {
    setSelected(m);
    setAssetClass(m.assetClass);
    setQuote(null);
    setQuoteError(null);
    setErrors({});
    if (held.has(m.symbol)) return;
    try {
      setQuote(await priceService.quote(m.symbol));
    } catch (err) {
      setQuoteError(err instanceof Error ? err.message : 'Couldn’t load the price.');
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setErrors({});
    try {
      const history = await priceService.historyFor(selected.symbol);
      const quotePoint = quote ? withoutInstrument(quoteToPoint('', quote, new Date())) : null;
      const known = [...history.points, ...(quotePoint ? [quotePoint] : [])].map((p) => ({ ...p, instrumentId: '' }));
      const parsed = parseMarketStart(start, today, known);
      if (!parsed.ok) {
        setErrors(parsed.errors);
        setBusy(false);
        return;
      }
      const toWrite = [...(history.fresh ? history.points : []), ...(quotePoint ? [quotePoint] : [])];
      await assetRepo.addMarketAsset(portfolio.id, { symbol: selected.symbol, name: selected.name, exchange: selected.exchange, assetClass }, parsed.value, toWrite);
      void priceService.tick();
      navigate(href.portfolio(portfolio.id));
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Saving failed.' });
      setBusy(false);
    }
  };

  const units = Dec.tryParse(start.units);
  const cost = Dec.tryParse(start.cost);
  const preview = units?.isPositive() ? (cost?.isPositive() ? units.mul(cost) : quote && !start.date ? units.mul(quote.price) : null) : null;

  return (
    <div className="stack">
      <form className="card stack" onSubmit={search} role="search" noValidate>
        <Field label="Ticker or name" error={searchError ?? undefined} hint="US-listed stocks and ETFs. Each search uses 1 of your 800 free daily credits.">
          {(p) => (
            <div className="row-start search-row">
              <input
                {...p}
                className="input grow"
                value={query}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="e.g. VTI or Vanguard"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSearchError(null);
                }}
              />
              <button type="submit" className="btn btn-primary" disabled={searching}>
                {searching ? 'Searching…' : 'Search'}
              </button>
            </div>
          )}
        </Field>

        {results && results.length > 0 && (
          <ul className="result-list" aria-label="Search results">
            {results.map((m) => (
              <li key={m.symbol}>
                <button
                  type="button"
                  className={`result ${selected?.symbol === m.symbol ? 'result-on' : ''}`}
                  aria-pressed={selected?.symbol === m.symbol}
                  onClick={() => void choose(m)}
                >
                  <span>
                    <b>{m.symbol}</b> · {m.name}
                    <span className="muted small block">
                      {m.type || 'Security'} · {m.exchange}
                      {held.has(m.symbol) && ' · already in this portfolio'}
                    </span>
                  </span>
                  {selected?.symbol === m.symbol && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>

      {selected && (
        <form className="stack" onSubmit={submit} noValidate>
          <section className="card stack" aria-label={`${selected.symbol} details`}>
            <div className="row-between baseline wrap">
              <h2 className="section-title">
                {selected.symbol} <span className="muted normal small">{selected.name}</span>
              </h2>
            </div>
            {held.has(selected.symbol) ? (
              <p className="field-error">{selected.symbol} is already in this portfolio.</p>
            ) : quote ? (
              <p className="row-between baseline">
                <span className="big-number">{formatUsd(quote.price)}</span>
                <span className="muted small">
                  {marketPriceLabel({ intraday: quote.marketOpen, updatedAt: new Date(quote.observedAt).toISOString(), date: quote.date })}
                </span>
              </p>
            ) : quoteError ? (
              <p className="field-error">{quoteError}</p>
            ) : (
              <p className="muted small">Loading price…</p>
            )}
            <Field label="Asset class">
              {(p) => (
                <select {...p} className="input" value={assetClass} onChange={(e) => setAssetClass(e.target.value as AssetClass)}>
                  {CLASSES.map((c) => (
                    <option key={c} value={c}>
                      {ASSET_CLASS_LABELS[c]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </section>

          <section className="card stack">
            <h2 className="section-title">
              Starting position <span className="muted normal">· optional</span>
            </h2>
            <p className="muted small">Shares already held. Leave empty to start at zero and buy through contributions later.</p>
            <div className="grid-2">
              <Field label="Shares" error={errors.units}>
                {(p) => (
                  <input {...p} className="input" inputMode="decimal" placeholder="0" value={start.units} onChange={(e) => setStart((s) => ({ ...s, units: e.target.value }))} />
                )}
              </Field>
              <Field label="Purchase date" error={errors.date}>
                {(p) => (
                  <input {...p} className="input" type="date" max={today} value={start.date} onChange={(e) => setStart((s) => ({ ...s, date: e.target.value }))} />
                )}
              </Field>
            </div>
            <Field label="Cost per share ($)" error={errors.cost} hint="Leave empty to use the closing price on the purchase date.">
              {(p) => (
                <input {...p} className="input" inputMode="decimal" placeholder="closing price that day" value={start.cost} onChange={(e) => setStart((s) => ({ ...s, cost: e.target.value }))} />
              )}
            </Field>
            {preview && <p className="small">Starting value: about {formatUsd(preview)}</p>}
          </section>

          {errors.form && (
            <p className="field-error" role="alert">
              {errors.form}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-large" disabled={busy || held.has(selected.symbol)}>
            {busy ? 'Downloading price history…' : `Add ${selected.symbol} to ${portfolio.name}`}
          </button>
          <p className="muted small center">Adding downloads its daily price history once (1 credit).</p>
        </form>
      )}
    </div>
  );
}
