import { useState } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import {
  loadPortfolioDetail,
  previewAssetDeletion,
  PORTFOLIO_STORES,
  type AssetDeletionPreview,
  type AssetRow,
  type PortfolioDetail,
} from '../../application/portfolioQueries';
import type { Dec } from '../../domain/money/decimal';
import { formatPct, formatQty, formatUsd } from '../../domain/money/format';
import { describeAge } from '../../domain/pricing/prices';
import { ASSET_CLASS_LABELS } from '../../domain/types';
import { href } from '../../app/routes';
import { Gain } from '../components/Money';
import { PriceStatusLine } from '../components/PriceStatusLine';
import { marketPriceLabel } from '../components/priceLabels';
import { Dialog } from '../components/Dialog';
import { HoldingUpdateForm } from '../components/HoldingUpdateForm';
import { assetRepo } from '../../data/repositories/assetRepo';

/** Bar colours for allocation slices, largest first. They step in lightness so they stay distinguishable without hue. */
const SLICE_COLORS = ['#1F5FBF', '#5585CF', '#8BAADF', '#B9CDEB', '#DCE6F5'];
const CASH_COLOR = '#A3A39C';

type Modal = { kind: 'none' } | { kind: 'price'; row: AssetRow } | { kind: 'asset'; row: AssetRow };

export function PortfolioScreen({ portfolioId }: { portfolioId: string }) {
  const detail = useLiveQuery(() => loadPortfolioDetail(portfolioId), PORTFOLIO_STORES, [portfolioId]);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const close = () => setModal({ kind: 'none' });

  if (detail.status === 'loading') return <p className="muted">Loading…</p>;
  if (detail.status === 'error') {
    return (
      <div className="card notice notice-danger" role="alert">
        Couldn't load this portfolio: {detail.error.message}
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="screen">
        <BackLink />
        <div className="card empty">
          <p className="empty-title">Portfolio not found</p>
          <p className="muted">It may have been deleted.</p>
        </div>
      </div>
    );
  }

  const { portfolio, rows, valuation } = detail.data;
  return (
    <div className="screen">
      <BackLink />
      <header className="stack-tight">
        <div className="row-start">
          <h1 className="screen-title">{portfolio.name}</h1>
          <span className="badge badge-info">Simulated</span>
        </div>
        <span className="hero-number">{formatUsd(valuation.totalValue)}</span>
        {valuation.netInvested.isZero() ? (
          <span className="muted">No money in yet</span>
        ) : (
          <Gain className="strong" amount={valuation.totalGain} pct={valuation.totalGainPct} />
        )}
      </header>

      <PriceStatusLine />

      <div className="stat-grid">
        <Stat label="Invested" value={formatUsd(valuation.netInvested)} />
        <Stat label="Cash" value={formatUsd(valuation.cash)} />
        <Stat label="Assets" value={String(rows.length)} />
      </div>

      <div className="button-pair">
        <button className="btn btn-primary" disabled title="Arrives with the contributions step">
          Add money <span className="soon">soon</span>
        </button>
        <a className="btn btn-secondary btn-link" href={href.addAsset(portfolio.id)}>
          Add asset
        </a>
      </div>

      {valuation.missingPrices.length > 0 && (
        <div className="card notice notice-warn" role="status">
          {valuation.missingPrices.length} holding(s) have no price yet, so they count as $0 in the total.
        </div>
      )}

      <AllocationCard detail={detail.data} />

      <section className="card holdings" aria-labelledby="holdings-title">
        <h2 id="holdings-title" className="section-title">
          Holdings
        </h2>
        {rows.length === 0 ? (
          <div className="stack-tight holdings-empty">
            <p className="muted">No assets yet. Add a manual-price asset to start tracking.</p>
            <a className="btn btn-secondary btn-link align-start" href={href.addAsset(portfolio.id)}>
              Add asset
            </a>
          </div>
        ) : (
          <ul className="holding-list">
            {rows.map((row) => (
              <HoldingRow
                key={row.link.id}
                row={row}
                onUpdatePrice={() => setModal({ kind: 'price', row })}
                onMore={() => setModal({ kind: 'asset', row })}
              />
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={modal.kind === 'price'}
        title={modal.kind === 'price' ? `Update · ${modal.row.instrument.name}` : ''}
        onClose={close}
      >
        {modal.kind === 'price' && (
          <HoldingUpdateForm
            unitsHeld={modal.row.quantity}
            currentPrice={modal.row.price?.price}
            marketPriceOn={modal.row.instrument.priceSource === 'market' ? (date) => modal.row.priceOn(date)?.price : undefined}
            onCancel={close}
            onSubmit={async (update) => {
              await assetRepo.updateHolding(portfolio.id, modal.row.instrument.id, update);
              close();
            }}
          />
        )}
      </Dialog>

      <Dialog open={modal.kind === 'asset'} title={modal.kind === 'asset' ? modal.row.instrument.name : ''} onClose={close}>
        {modal.kind === 'asset' && <AssetActions row={modal.row} onDone={close} />}
      </Dialog>
    </div>
  );
}

function BackLink() {
  return (
    <a className="back-link" href={href.portfolios()}>
      ‹ Portfolios
    </a>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function AllocationCard({ detail }: { detail: PortfolioDetail }) {
  const [by, setBy] = useState<'asset' | 'class'>('asset');
  const { valuation, rows, byClass } = detail;
  if (valuation.totalValue.isZero() || valuation.totalValue.isNegative()) return null;

  const nameOf = new Map(rows.map((r) => [r.instrument.id, r.instrument.symbol ?? r.instrument.name]));
  const slices: { key: string; label: string; weight: Dec; cash: boolean }[] =
    by === 'asset'
      ? [
          ...[...valuation.holdings]
            .filter((h) => !h.value.isZero())
            .sort((a, b) => b.value.cmp(a.value))
            .map((h) => ({ key: h.instrumentId, label: nameOf.get(h.instrumentId) ?? 'Unknown asset', weight: h.weight, cash: false })),
          ...(valuation.cash.isZero() ? [] : [{ key: 'cash', label: 'Cash', weight: valuation.cashWeight, cash: true }]),
        ]
      : byClass.map((s) => ({
          key: s.key,
          label: s.key === 'cash' ? 'Cash' : ASSET_CLASS_LABELS[s.key],
          weight: s.weight,
          cash: s.key === 'cash',
        }));

  let colorIndex = 0;
  const colored = slices.map((s) => ({
    ...s,
    color: s.cash ? CASH_COLOR : (SLICE_COLORS[Math.min(colorIndex++, SLICE_COLORS.length - 1)] as string),
  }));

  return (
    <section className="card stack" aria-labelledby="alloc-title">
      <div className="row-between">
        <h2 id="alloc-title" className="section-title">
          Allocation
        </h2>
        <div className="segmented" role="group" aria-label="Group allocation by">
          <button aria-pressed={by === 'asset'} onClick={() => setBy('asset')}>
            By asset
          </button>
          <button aria-pressed={by === 'class'} onClick={() => setBy('class')}>
            By class
          </button>
        </div>
      </div>
      <div className="alloc-bar" aria-hidden="true">
        {colored.map((s) => (
          <div key={s.key} style={{ width: `${s.weight.mul(100).toFixed(2)}%`, background: s.color }} />
        ))}
      </div>
      <ul className="alloc-list">
        {colored.map((s) => (
          <li key={s.key} className="row-between">
            <span className="row-start">
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </span>
            <span className="strong">{formatPct(s.weight, 1, false)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HoldingRow({ row, onUpdatePrice, onMore }: { row: AssetRow; onUpdatePrice: () => void; onMore: () => void }) {
  const { instrument, holding, quantity, price, manualStatus } = row;
  const manual = instrument.priceSource === 'manual';
  const unitWord = manual ? 'units' : 'shares';
  return (
    <li className="holding">
      <div className="row-between baseline">
        <span className="holding-name">
          {instrument.symbol ? (
            <>
              {instrument.symbol} <span className="muted normal small">{instrument.name}</span>
            </>
          ) : (
            instrument.name
          )}
        </span>
        <span className="row-end nowrap">
          <span className="strong">{holding ? formatUsd(holding.value) : '—'}</span>
          <button className="btn-icon small-icon" aria-label={`More options for ${instrument.symbol ?? instrument.name}`} onClick={onMore}>
            ···
          </button>
        </span>
      </div>
      <div className="row-between muted small wrap">
        <span>
          {quantity.isZero() ? `No ${unitWord} yet` : `${formatQty(quantity)} ${unitWord}`}
          {price && ` @ ${formatUsd(price.price, 4).replace(/(\.\d\d)00$/, '$1')}`} · {ASSET_CLASS_LABELS[instrument.assetClass]}
        </span>
        {holding && <Gain className="strong" amount={holding.gain} pct={holding.gainPct} />}
      </div>
      <div className="row-between wrap">
        {manual ? (
          <span className={`small ${manualStatus?.updateDue ? 'warn-text' : 'muted'}`}>
            Manual price · updated {price ? describeAge(manualStatus?.ageDays ?? 0) : 'never'}
            {manualStatus?.updateDue && ' · update due'}
          </span>
        ) : (
          <span className="small muted">{price ? marketPriceLabel(price) : 'Waiting for first price…'}</span>
        )}
        <button
          className="btn btn-small btn-outline"
          onClick={onUpdatePrice}
          aria-label={manual ? `Update units or price of ${instrument.name}` : `Change shares of ${instrument.symbol}`}
          disabled={!manual && !price}
        >
          {manual ? 'Update units / price' : 'Change shares'}
        </button>
      </div>
    </li>
  );
}

function AssetActions({ row, onDone }: { row: AssetRow; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [reminder, setReminder] = useState(String(row.link.priceReminderDays ?? ''));
  const [confirm, setConfirm] = useState<AssetDeletionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const name = row.instrument.name;

  if (confirm) {
    return (
      <div className="stack">
        <p>
          <b>Delete “{name}” from this portfolio?</b> It's removed as if it was never added, including{' '}
          {confirm.entries === 1 ? '1 ledger entry' : `${confirm.entries} ledger entries`}.
        </p>
        <p className="small">
          Portfolio value: {formatUsd(confirm.valueBefore)} → <b>{formatUsd(confirm.valueAfter)}</b>
        </p>
        {confirm.keptCash.isPositive() && (
          <p className="muted small">{formatUsd(confirm.keptCash)} from shared contributions stays in the portfolio as cash.</p>
        )}
        {confirm.cashGoesNegative && (
          <p className="warn-text small">
            Money from selling this asset was used for other purchases, so cash will go below $0 after deleting.
          </p>
        )}
        <p className="muted small">Sold the units for real? Use “Update units / price” → New total instead, which keeps the history.</p>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="row-end">
          <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
            Back
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              assetRepo.deleteAsset(row.link).then(onDone, (e: unknown) => {
                setError(e instanceof Error ? e.message : 'Delete failed.');
                setBusy(false);
              });
            }}
          >
            Delete asset
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {row.instrument.priceSource === 'manual' && (
        <label className="field">
          <span className="field-label">Remind me to update the price</span>
          <select
            className="input"
            value={reminder}
            onChange={(e) => {
              setReminder(e.target.value);
              void assetRepo.setReminder(row.link, e.target.value ? Number(e.target.value) : undefined);
            }}
          >
            <option value="14">Every 2 weeks</option>
            <option value="7">Every week</option>
            <option value="">Never</option>
          </select>
        </label>
      )}
      <button
        className="btn btn-danger-outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          previewAssetDeletion(row.link).then(
            (p) => {
              setConfirm(p);
              setBusy(false);
            },
            (e: unknown) => {
              setError(e instanceof Error ? e.message : 'Could not prepare delete.');
              setBusy(false);
            },
          );
        }}
      >
        Delete asset…
      </button>
      <p className="muted small">For an asset added by mistake. You'll see what changes before anything is deleted.</p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-ghost" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
