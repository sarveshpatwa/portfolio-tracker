import { useState } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { LABEL, ledgerCsv, loadLedger, MONEY_STORES, type LedgerGroup } from '../../application/moneyQueries';
import { formatQty, formatUsd } from '../../domain/money/format';
import { href } from '../../app/routes';
import { fmtDate } from './MoneyScreen';

type Filter = 'all' | 'contributions' | 'other';

export function LedgerScreen({ portfolioId }: { portfolioId: string }) {
  const data = useLiveQuery(() => loadLedger(portfolioId), MONEY_STORES, [portfolioId]);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());

  if (data.status === 'loading') return <p className="muted">Loading…</p>;
  if (data.status === 'error') return <p className="field-error">Couldn't load: {data.error.message}</p>;
  if (!data.data) return <p>Portfolio not found.</p>;
  const { portfolio, groups, names, count } = data.data;

  const isContribution = (g: LedgerGroup) => g.entries.some((e) => e.contributionId);
  const shown = groups.filter((g) => filter === 'all' || (filter === 'contributions') === isContribution(g));
  const contributions = groups.filter(isContribution).length;

  const exportCsv = () => {
    const csv = ledgerCsv(
      groups.flatMap((g) => g.entries),
      names,
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${portfolio.name.replace(/[^\w-]+/g, '-')}-ledger.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="screen">
      <div className="row-between">
        <a className="back-link" href={href.portfolio(portfolio.id)}>
          ‹ {portfolio.name}
        </a>
        <button className="btn btn-small btn-outline" onClick={exportCsv} disabled={count === 0}>
          Export CSV
        </button>
      </div>
      <h1 className="screen-title">Ledger</h1>
      <div className="segmented" role="group" aria-label="Filter entries">
        <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All · {groups.length}
        </button>
        <button aria-pressed={filter === 'contributions'} onClick={() => setFilter('contributions')}>
          Contributions · {contributions}
        </button>
        <button aria-pressed={filter === 'other'} onClick={() => setFilter('other')}>
          Other · {groups.length - contributions}
        </button>
      </div>

      {shown.length === 0 && <p className="muted">No entries yet.</p>}
      {shown.map((g) => {
        const expandable = g.entries.length > 1;
        const expanded = !expandable || open.has(g.key) || shown.indexOf(g) === 0;
        return (
          <section key={g.key} className="card ledger-group">
            <button
              className="ledger-head"
              aria-expanded={expandable ? expanded : undefined}
              disabled={!expandable}
              onClick={() =>
                setOpen((s) => {
                  const n = new Set(s);
                  if (n.has(g.key)) n.delete(g.key);
                  else n.add(g.key);
                  return n;
                })
              }
            >
              <span className="row-between baseline">
                <span className="strong">
                  {fmtDate(g.date)} · {g.title}
                </span>
                <span className="strong">
                  {g.total ? formatUsd(g.total) : formatUsd(g.entries[0]!.amount)}
                  {expandable && <span aria-hidden="true">{expanded ? ' ▾' : ' ›'}</span>}
                </span>
              </span>
              {(g.subtitle || expandable) && (
                <span className="muted small block">
                  {g.subtitle}
                  {g.subtitle && expandable ? ' · ' : ''}
                  {expandable ? `${g.entries.length} entries` : ''}
                </span>
              )}
            </button>
            {expanded && (
              <ul className="ledger-entries">
                {g.entries.map((t) => (
                  <li key={t.id} className="row-between small">
                    <span>
                      <span className={`entry-type type-${t.type.toLowerCase()}`}>{LABEL[t.type] ?? t.type}</span>{' '}
                      {t.instrumentId ? (
                        <>
                          {names.get(t.instrumentId) ?? 'Removed asset'} {t.quantity && formatQty(t.quantity)}
                          {t.price && ` @ ${formatUsd(t.price, 4).replace(/(\.\d\d)00$/, '$1')}`}
                        </>
                      ) : (
                        'Cash'
                      )}
                    </span>
                    <span>{formatUsd(t.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <p className="muted small">
        Entries are never edited. To fix a mistake, use “Update units / price” or delete the asset — the history stays explainable.
      </p>
    </div>
  );
}
