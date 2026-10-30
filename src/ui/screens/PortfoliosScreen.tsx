import { useState, type FormEvent } from 'react';
import type { Portfolio } from '../../domain/types';
import { MAX_NAME_LENGTH, portfolioRepo } from '../../data/repositories/portfolioRepo';
import { S } from '../../data/db/schema';
import { useLiveQuery } from '../../application/useLiveQuery';
import { loadPortfolioSummaries, PORTFOLIO_STORES } from '../../application/portfolioQueries';
import { Dialog } from '../components/Dialog';
import { Gain } from '../components/Money';
import { formatUsd } from '../../domain/money/format';
import { href } from '../../app/routes';
import { backupRepo } from '../../data/repositories/backupRepo';
import { describeAge } from '../../domain/pricing/prices';
import { daysBetween, todayLocal } from '../../domain/calendar/dates';

type Modal =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'actions'; portfolio: Portfolio }
  | { kind: 'rename'; portfolio: Portfolio }
  | { kind: 'delete'; portfolio: Portfolio };

const createdFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function PortfoliosScreen() {
  const portfolios = useLiveQuery(() => loadPortfolioSummaries(), [...PORTFOLIO_STORES, S.portfolios]);
  const lastBackup = useLiveQuery(() => backupRepo.lastBackupAt(), [S.settings]);
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const close = () => setModal({ kind: 'none' });
  const hasData = portfolios.status === 'ready' && portfolios.data.length > 0;
  const backupAgeDays =
    lastBackup.status === 'ready' && lastBackup.data ? daysBetween(todayLocal(new Date(lastBackup.data)), todayLocal()) : null;

  return (
    <div className="screen">
      <header className="screen-header">
        <h1 className="screen-title">Portfolios</h1>
        <button className="btn btn-primary btn-pill" onClick={() => setModal({ kind: 'create' })}>
          + New portfolio
        </button>
      </header>
      <p className="muted small">Simulated money only · your data stays on this device</p>
      {hasData && lastBackup.status === 'ready' && (
        <p className={`small backup-nudge ${backupAgeDays === null || backupAgeDays >= 7 ? 'warn-text' : 'muted'}`}>
          <span>{backupAgeDays === null ? 'Not backed up yet' : `Last backup ${describeAge(backupAgeDays)}`}</span>
          <a href={href.settings()}>Back up or restore ›</a>
        </p>
      )}

      {portfolios.status === 'loading' && <p className="muted">Loading…</p>}
      {portfolios.status === 'error' && (
        <div className="card notice notice-danger" role="alert">
          Couldn't open your data: {portfolios.error.message}
        </div>
      )}
      {portfolios.status === 'ready' && portfolios.data.length === 0 && (
        <div className="card empty">
          <p className="empty-title">No portfolios yet</p>
          <p className="muted">Create one for each strategy you want to compare, then add assets and simulated money.</p>
          <button className="btn btn-primary" onClick={() => setModal({ kind: 'create' })}>
            Create your first portfolio
          </button>
        </div>
      )}
      {portfolios.status === 'ready' && portfolios.data.length > 0 && (
        <ul className="list" aria-label="Your portfolios">
          {portfolios.data.map(({ portfolio: p, valuation, assetCount, pricesDue }) => (
            <li key={p.id} className="card portfolio-card">
              <div className="row-between">
                <h2 className="card-title">
                  <a className="card-link" href={href.portfolio(p.id)}>
                    {p.name}
                  </a>
                </h2>
                <div className="row-end nowrap">
                  {pricesDue > 0 && (
                    <span className="badge badge-warn">
                      {pricesDue} price {pricesDue === 1 ? 'update' : 'updates'} due
                    </span>
                  )}
                  <button
                    className="btn-icon"
                    aria-label={`Options for ${p.name}: rename or delete`}
                    onClick={() => setModal({ kind: 'actions', portfolio: p })}
                  >
                    ···
                  </button>
                </div>
              </div>
              <div className="row-between baseline wrap">
                <span className="big-number">{formatUsd(valuation.totalValue)}</span>
                {valuation.netInvested.isZero() ? (
                  <span className="muted small">No money in yet</span>
                ) : (
                  <Gain className="small strong" amount={valuation.totalGain} pct={valuation.totalGainPct} />
                )}
              </div>
              <span className="muted small">
                {assetCount === 0 ? 'No assets yet' : `${assetCount} ${assetCount === 1 ? 'asset' : 'assets'}`} · created{' '}
                {createdFmt.format(new Date(p.createdAt))}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={modal.kind === 'create'} title="New portfolio" onClose={close}>
        <NameForm
          submitLabel="Create"
          onCancel={close}
          onSubmit={async (name) => {
            await portfolioRepo.create(name);
            close();
          }}
        />
      </Dialog>

      <Dialog open={modal.kind === 'actions'} title={modal.kind === 'actions' ? modal.portfolio.name : ''} onClose={close}>
        {modal.kind === 'actions' && (
          <div className="stack">
            <button className="btn btn-secondary" onClick={() => setModal({ kind: 'rename', portfolio: modal.portfolio })}>
              Rename
            </button>
            <button className="btn btn-danger-outline" onClick={() => setModal({ kind: 'delete', portfolio: modal.portfolio })}>
              Delete
            </button>
            <button className="btn btn-ghost" onClick={close}>
              Cancel
            </button>
          </div>
        )}
      </Dialog>

      <Dialog open={modal.kind === 'rename'} title="Rename portfolio" onClose={close}>
        {modal.kind === 'rename' && (
          <NameForm
            initial={modal.portfolio.name}
            submitLabel="Save"
            onCancel={close}
            onSubmit={async (name) => {
              await portfolioRepo.rename(modal.portfolio.id, name);
              close();
            }}
          />
        )}
      </Dialog>

      <Dialog open={modal.kind === 'delete'} title="Delete portfolio?" onClose={close}>
        {modal.kind === 'delete' && (
          <DeleteConfirm portfolio={modal.portfolio} onCancel={close} onDeleted={close} />
        )}
      </Dialog>
    </div>
  );
}

function NameForm({
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="input"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'name-error' : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="e.g. Growth"
        />
      </label>
      {error && (
        <p id="name-error" className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="row-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function DeleteConfirm({ portfolio, onCancel, onDeleted }: { portfolio: Portfolio; onCancel: () => void; onDeleted: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack">
      <p>
        “{portfolio.name}” and its ledger, allocation, recurring contributions and switch links will be deleted from this
        device. This can't be undone.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="row-end">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn btn-danger"
          onClick={() =>
            portfolioRepo.remove(portfolio.id).then(onDeleted, (err: unknown) => setError(err instanceof Error ? err.message : 'Delete failed.'))
          }
        >
          Delete
        </button>
      </div>
    </div>
  );
}
