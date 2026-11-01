import { useState, type FormEvent } from 'react';
import { Field } from '../components/Field';
import { useLiveQuery } from '../../application/useLiveQuery';
import { loadPortfolioDetail, PORTFOLIO_STORES } from '../../application/portfolioQueries';
import { parseManualAssetForm, type FieldErrors, type ManualAssetFormInput } from '../../domain/assets/manualAssetForm';
import { todayLocal } from '../../domain/calendar/dates';
import { Dec } from '../../domain/money/decimal';
import { formatUsd } from '../../domain/money/format';
import type { AssetClass } from '../../domain/types';
import { assetRepo } from '../../data/repositories/assetRepo';
import { settingsRepo } from '../../data/repositories/settingsRepo';
import { S } from '../../data/db/schema';
import { href, navigate } from '../../app/routes';
import type { Portfolio } from '../../domain/types';
import type { AssetRow } from '../../application/portfolioQueries';
import { MarketAssetForm } from '../components/MarketAssetForm';

const CLASS_OPTIONS: { value: AssetClass; label: string }[] = [
  { value: 'fund', label: 'Private fund / mutual fund' },
  { value: 'etf', label: 'ETF (not listed)' },
  { value: 'stock', label: 'Stock (not listed)' },
  { value: 'bond', label: 'Bond' },
  { value: 'other', label: 'Other' },
];

type Mode = 'market' | 'manual';

export function AddAssetScreen({ portfolioId }: { portfolioId: string }) {
  const detail = useLiveQuery(() => loadPortfolioDetail(portfolioId), PORTFOLIO_STORES, [portfolioId]);
  const settings = useLiveQuery(() => settingsRepo.market(), [S.settings]);
  const [mode, setMode] = useState<Mode | null>(null);

  if (detail.status !== 'ready' || settings.status !== 'ready') return <p className="muted">Loading…</p>;
  if (!detail.data) {
    return (
      <div className="screen">
        <a className="back-link" href={href.portfolios()}>
          ‹ Portfolios
        </a>
        <p>Portfolio not found.</p>
      </div>
    );
  }
  const { portfolio, rows } = detail.data;
  const hasKey = !!settings.data.apiKey;
  const current: Mode = mode ?? (hasKey ? 'market' : 'manual');

  return (
    <div className="screen">
      <a className="back-link" href={href.portfolio(portfolio.id)}>
        ‹ {portfolio.name}
      </a>
      <h1 className="screen-title">Add asset</h1>
      <div className="segmented segmented-large" role="group" aria-label="Price source">
        <button type="button" aria-pressed={current === 'market'} onClick={() => setMode('market')}>
          Market ticker
        </button>
        <button type="button" aria-pressed={current === 'manual'} onClick={() => setMode('manual')}>
          Manual price
        </button>
      </div>
      {current === 'market' ? (
        hasKey ? (
          <MarketAssetForm portfolio={portfolio} rows={rows} />
        ) : (
          <div className="card stack">
            <p className="small">
              Live prices for US-listed stocks and ETFs need a free Twelve Data API key. Add it in Settings, then come back here.
            </p>
            <a className="btn btn-primary btn-link" href={href.settings()}>
              Open Settings
            </a>
          </div>
        )
      ) : (
        <ManualAssetForm portfolio={portfolio} rows={rows} />
      )}
    </div>
  );
}

function ManualAssetForm({ portfolio, rows }: { portfolio: Portfolio; rows: AssetRow[] }) {
  const today = todayLocal();
  const [form, setForm] = useState<ManualAssetFormInput>({
    name: '',
    assetClass: 'fund',
    price: '',
    priceDate: today,
    reminderDays: '14',
    startQuantity: '',
    startCost: '',
    startDate: '',
  });
  const [errors, setErrors] = useState<FieldErrors & { form?: string }>({});
  const [busy, setBusy] = useState(false);

  const set = (field: keyof ManualAssetFormInput) => (value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined, form: undefined }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseManualAssetForm(form, today, rows.map((r) => r.instrument.name));
    if (!parsed.ok) {
      setErrors(parsed.errors);
      // Move focus to the first invalid field so screen-reader and keyboard users land on it.
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      await assetRepo.addManualAsset(portfolio.id, parsed.value);
      navigate(href.portfolio(portfolio.id));
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Saving failed.' });
      setBusy(false);
    }
  };

  const startValue = (() => {
    const q = Dec.tryParse(form.startQuantity);
    const c = Dec.tryParse(form.startCost) ?? Dec.tryParse(form.price);
    return q && c && q.isPositive() && c.isPositive() ? q.mul(c) : null;
  })();

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p className="muted small">For private or unlisted funds and stocks: you enter the price and update it yourself.</p>

      <section className="card stack">
        <Field label="Name" error={errors.name}>
          {(p) => (
            <input
              {...p}
              className="input"
              value={form.name}
              maxLength={60}
              placeholder="e.g. Private Fund A"
              onChange={(e) => set('name')(e.target.value)}
            />
          )}
        </Field>
        <Field label="Asset class">
          {(p) => (
            <select {...p} className="input" value={form.assetClass} onChange={(e) => set('assetClass')(e.target.value)}>
              {CLASS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="grid-2">
          <Field label="Price per unit ($)" error={errors.price}>
            {(p) => (
              <input
                {...p}
                className="input"
                inputMode="decimal"
                value={form.price}
                placeholder="0.00"
                onChange={(e) => set('price')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Price as of" error={errors.priceDate}>
            {(p) => (
              <input
                {...p}
                className="input"
                type="date"
                value={form.priceDate}
                max={today}
                onChange={(e) => set('priceDate')(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Remind me to update the price">
          {(p) => (
            <select {...p} className="input" value={form.reminderDays} onChange={(e) => set('reminderDays')(e.target.value)}>
              <option value="14">Every 2 weeks</option>
              <option value="7">Every week</option>
              <option value="">Never</option>
            </select>
          )}
        </Field>
      </section>

      <section className="card stack">
        <h2 className="section-title">
          Starting position <span className="muted normal">· optional</span>
        </h2>
        <p className="muted small">Units already held. Leave empty to start at zero and buy through contributions later.</p>
        <div className="grid-2">
          <Field label="Units" error={errors.startQuantity}>
            {(p) => (
              <input
                {...p}
                className="input"
                inputMode="decimal"
                value={form.startQuantity}
                placeholder="0"
                onChange={(e) => set('startQuantity')(e.target.value)}
              />
            )}
          </Field>
          <Field label="Cost per unit ($)" error={errors.startCost}>
            {(p) => (
              <input
                {...p}
                className="input"
                inputMode="decimal"
                value={form.startCost}
                placeholder={form.price || 'same as price'}
                onChange={(e) => set('startCost')(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Purchase date" error={errors.startDate}>
          {(p) => (
            <input
              {...p}
              className="input"
              type="date"
              value={form.startDate}
              max={today}
              onChange={(e) => set('startDate')(e.target.value)}
            />
          )}
        </Field>
        {startValue && <p className="small">Starting value: {formatUsd(startValue)}</p>}
      </section>

      {errors.form && (
        <p className="field-error" role="alert">
          {errors.form}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-large" disabled={busy}>
        Add to {portfolio.name}
      </button>
    </form>
  );
}

