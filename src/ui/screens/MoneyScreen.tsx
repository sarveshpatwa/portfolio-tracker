import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { loadMoney, MONEY_STORES, type MoneyData } from '../../application/moneyQueries';
import { contributionRepo } from '../../data/repositories/contributionRepo';
import { describeIssue, planInEffect, validateAllocation } from '../../domain/contributions/allocation';
import { todayLocal } from '../../domain/calendar/dates';
import { Dec } from '../../domain/money/decimal';
import { href } from '../../app/routes';
import { OneTimeContribution, RecurringRules } from '../components/ContributionForms';

const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
export const fmtDate = (iso: string) => shortDate.format(new Date(`${iso}T00:00:00Z`));

export function MoneyScreen({ portfolioId }: { portfolioId: string }) {
  const data = useLiveQuery(() => loadMoney(portfolioId), MONEY_STORES, [portfolioId]);
  if (data.status === 'loading') return <p className="muted">Loading…</p>;
  if (data.status === 'error') return <p className="field-error">Couldn't load: {data.error.message}</p>;
  if (!data.data) return <p>Portfolio not found.</p>;
  const d = data.data;

  return (
    <div className="screen">
      <a className="back-link" href={href.portfolio(d.portfolio.id)}>
        ‹ {d.portfolio.name}
      </a>
      <h1 className="screen-title">Money &amp; allocation</h1>
      {d.assets.length === 0 ? (
        <div className="card empty">
          <p className="empty-title">Add assets first</p>
          <p className="muted">Contributions are split across the portfolio's assets by target percentages.</p>
          <a className="btn btn-primary btn-link" href={href.addAsset(d.portfolio.id)}>
            Add asset
          </a>
        </div>
      ) : (
        <>
          <AllocationEditor data={d} />
          <BuyRules data={d} />
          <OneTimeContribution data={d} />
          <RecurringRules data={d} />
          <a className="btn btn-ghost btn-link" href={href.ledger(d.portfolio.id)}>
            View ledger ›
          </a>
        </>
      )}
    </div>
  );
}

function AllocationEditor({ data }: { data: MoneyData }) {
  const { portfolio, assets, plans } = data;
  const current = planInEffect(plans, todayLocal()) ?? plans[plans.length - 1];
  const initial = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of assets) m[a.instrument.id] = current?.targets.find((t) => t.instrumentId === a.instrument.id)?.pct ?? '';
    return m;
  }, [assets, current]);
  const [pcts, setPcts] = useState<Record<string, string>>(initial);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setPcts(initial), [initial]);

  const nameOf = (id: string) => {
    const i = assets.find((a) => a.instrument.id === id)?.instrument;
    return i ? (i.symbol ?? i.name) : 'Removed asset';
  };
  const targets = assets.map((a) => ({ instrumentId: a.instrument.id, pct: (pcts[a.instrument.id] ?? '').trim() || '0' }));
  const check = validateAllocation(targets.filter((t) => Dec.tryParse(t.pct)?.isPositive() || !Dec.tryParse(t.pct)));
  const changed = assets.some((a) => (Dec.tryParse(pcts[a.instrument.id] || '0')?.toString() ?? 'x') !== (Dec.tryParse(initial[a.instrument.id] || '0')?.toString() ?? 'y'));
  const removedFromPlan = current?.targets.filter((t) => !assets.some((a) => a.instrument.id === t.instrumentId) && Dec.from(t.pct).isPositive()) ?? [];
  const nextVersion = Math.max(0, ...plans.map((p) => p.version)) + 1;

  const save = async () => {
    setNotice(null);
    try {
      const plan = await contributionRepo.saveAllocation(
        portfolio.id,
        targets.filter((t) => Dec.tryParse(t.pct)?.isPositive()),
        nameOf,
      );
      setNotice({ ok: true, text: `Saved as version ${plan.version}. It applies to contributions from today; past ones keep their version.` });
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'Saving failed.' });
    }
  };

  return (
    <section className="card stack" aria-labelledby="alloc-edit-title">
      <div className="row-between baseline wrap">
        <h2 id="alloc-edit-title" className="section-title">
          Target allocation
        </h2>
        <span className="muted small">{current ? `Version ${current.version} · since ${fmtDate(current.effectiveFrom)}` : 'Not set yet'}</span>
      </div>
      <p className="muted small">How each contribution is split. Totals must reach 100%.</p>
      <ul className="target-list">
        {assets.map(({ instrument }) => {
          const id = `pct-${instrument.id}`;
          return (
            <li key={instrument.id} className="row-between">
              <label htmlFor={id} className="target-name">
                {instrument.symbol ?? instrument.name}
                {instrument.symbol && <span className="muted small block">{instrument.name}</span>}
              </label>
              <span className="row-start nowrap">
                <input
                  id={id}
                  aria-label={`${instrument.symbol ?? instrument.name} target percent`}
                  className="input pct-input"
                  inputMode="decimal"
                  placeholder="0"
                  value={pcts[instrument.id] ?? ''}
                  onChange={(e) => {
                    setPcts((p) => ({ ...p, [instrument.id]: e.target.value }));
                    setNotice(null);
                  }}
                />
                <span aria-hidden="true">%</span>
              </span>
            </li>
          );
        })}
      </ul>
      {check.ok ? (
        <p className="notice-inline notice-ok">Total 100% ✓</p>
      ) : (
        <p className="notice-inline notice-err" role="status">
          {check.issues.map((i) => describeIssue(i, nameOf)).join(' ')}
        </p>
      )}
      {removedFromPlan.length > 0 && (
        <p className="warn-text small">
          The saved version still includes removed assets ({removedFromPlan.map((t) => nameOf(t.instrumentId)).join(', ')}). Save a new version so
          contributions can run.
        </p>
      )}
      <button className="btn btn-secondary" disabled={!check.ok || (!changed && removedFromPlan.length === 0 && !!current)} onClick={() => void save()}>
        Save as version {nextVersion}
      </button>
      {notice && (
        <p className={`notice-inline ${notice.ok ? 'notice-ok' : 'notice-err'}`} role={notice.ok ? 'status' : 'alert'}>
          {notice.text}
        </p>
      )}
      {plans.length > 0 && (
        <details className="details">
          <summary>Version history ({plans.length})</summary>
          <ul className="version-list">
            {[...plans].reverse().map((p) => (
              <li key={p.id}>
                <b>v{p.version}</b> · {fmtDate(p.effectiveFrom)} ·{' '}
                {p.targets
                  .filter((t) => Dec.from(t.pct).isPositive())
                  .map((t) => `${nameOf(t.instrumentId)} ${Dec.from(t.pct).toString()}%`)
                  .join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function BuyRules({ data }: { data: MoneyData }) {
  const p = data.portfolio;
  // Shown immediately; saved in the background (the screen re-reads the database afterwards).
  const [mode, setMode] = useState(p.buyMode);
  const [topUp, setTopUp] = useState(p.topUpWholeShares);
  useEffect(() => {
    setMode(p.buyMode);
    setTopUp(p.topUpWholeShares);
  }, [p.buyMode, p.topUpWholeShares]);
  const set = (m: 'fractional' | 'whole', t = topUp) => {
    setMode(m);
    setTopUp(t);
    void contributionRepo.setBuySettings(p, m, t);
  };
  return (
    <section className="card stack" aria-labelledby="buy-title">
      <h2 id="buy-title" className="section-title">
        How to buy
      </h2>
      <div className="stack-tight" role="radiogroup" aria-labelledby="buy-title">
        <label className={`choice ${mode === 'fractional' ? 'choice-on' : ''}`}>
          <input type="radio" name="buymode" checked={mode === 'fractional'} onChange={() => set('fractional')} />
          <span>
            <b>Fractional shares</b>
            <span className="muted small block">Buy exact amounts, rounded down to {p.fractionDigits} decimals. Leftover under a cent stays as cash.</span>
          </span>
        </label>
        <label className={`choice ${mode === 'whole' ? 'choice-on' : ''}`}>
          <input type="radio" name="buymode" checked={mode === 'whole'} onChange={() => set('whole')} />
          <span>
            <b>Whole shares only</b>
            <span className="muted small block">Round down to whole shares; the remainder stays as cash.</span>
          </span>
        </label>
      </div>
      {mode === 'whole' && (
        <label className="row-start small">
          <input type="checkbox" className="check" checked={topUp} onChange={(e) => set('whole', e.target.checked)} />
          Spend leftover cash on assets still below their target
        </label>
      )}
    </section>
  );
}
