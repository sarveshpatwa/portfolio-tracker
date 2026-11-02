import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { MoneyData } from '../../application/moneyQueries';
import { contributionService, type OneTimePreview } from '../../application/contributionService';
import { contributionRepo } from '../../data/repositories/contributionRepo';
import { FREQUENCIES, parseOneTime, parseRule, type RuleInput } from '../../domain/contributions/forms';
import { nextScheduledDate } from '../../domain/contributions/schedule';
import { todayLocal } from '../../domain/calendar/dates';
import { Dec } from '../../domain/money/decimal';
import { formatQty, formatUsd } from '../../domain/money/format';
import type { ContributionRule } from '../../domain/types';
import { Field } from './Field';
import { Dialog } from './Dialog';
import { fmtDate } from '../screens/MoneyScreen';

// --- One-time --------------------------------------------------------------

export function OneTimeContribution({ data }: { data: MoneyData }) {
  const today = todayLocal();
  const { portfolio, assets, cash } = data;
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [investCash, setInvestCash] = useState(true);
  const [preview, setPreview] = useState<OneTimePreview | null>(null);
  const [errors, setErrors] = useState<{ amount?: string; date?: string; form?: string }>({});
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => {
    const i = assets.find((a) => a.instrument.id === id)?.instrument;
    return i ? (i.symbol ?? i.name) : 'Removed asset';
  };

  // Recompute the preview as the inputs change (debounced).
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      const amt = Dec.tryParse(amount);
      void contributionService
        .previewOneTime(portfolio, amt && amt.isPositive() ? amt : null, date || today, investCash, today)
        .then((p) => !cancelled && setPreview(p));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [amount, date, investCash, portfolio, today, data]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    const r = parseOneTime({ amount, date }, today);
    if (!r.ok) return setErrors(r.errors);
    setBusy(true);
    try {
      const plan = await contributionService.addOneTime(portfolio, r.amount, r.date, investCash);
      setDone(
        `Added ${formatUsd(r.amount)} on ${fmtDate(r.date)}: ${plan.lines
          .filter((l) => !l.quantity.isZero())
          .map((l) => `${formatQty(l.quantity)} ${nameOf(l.instrumentId)}`)
          .join(', ')}.`,
      );
      setAmount('');
      setErrors({});
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Saving failed.' });
    } finally {
      setBusy(false);
    }
  };

  const showCashOption = cash.gte('0.01') && date >= today;

  return (
    <section className="card stack" aria-labelledby="onetime-title">
      <h2 id="onetime-title" className="section-title">
        One-time contribution
      </h2>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="grid-2">
          <Field label="Amount ($)" error={errors.amount}>
            {(p) => (
              <input
                {...p}
                className="input"
                inputMode="decimal"
                placeholder="1,000"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setErrors({});
                  setDone(null);
                }}
              />
            )}
          </Field>
          <Field label="Date" error={errors.date}>
            {(p) => <input {...p} className="input" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
        </div>
        {showCashOption && (
          <label className="row-start small">
            <input type="checkbox" className="check" checked={investCash} onChange={(e) => setInvestCash(e.target.checked)} />
            Also invest the {formatUsd(cash)} cash already in this portfolio
          </label>
        )}

        <PreviewTable preview={preview} nameOf={nameOf} />

        <p className="muted small">
          {date < today
            ? 'Past date: each asset is bought at its closing price on (or the last trading day before) that date. Manual assets use the latest price you entered by then.'
            : 'Bought at current prices (live during US market hours).'}
        </p>
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-large" disabled={busy || !preview?.purchase}>
          {busy ? 'Adding…' : Dec.tryParse(amount)?.isPositive() ? `Add ${formatUsd(Dec.from(amount))} simulated` : 'Add simulated money'}
        </button>
        {done && (
          <p className="notice-inline notice-ok" role="status">
            {done}
          </p>
        )}
      </form>
    </section>
  );
}

function PreviewTable({ preview, nameOf }: { preview: OneTimePreview | null; nameOf: (id: string) => string }) {
  if (!preview) return null;
  if (!preview.planOk) return <p className="warn-text small">Set a target allocation that totals 100% (above) before adding money.</p>;
  if (preview.missing.length > 0) {
    return <p className="warn-text small">No price for {preview.missing.map((m) => nameOf(m.instrumentId)).join(', ')} on that date. Pick a later date, or add a price.</p>;
  }
  if (preview.error) return <p className="field-error small">{preview.error}</p>;
  const plan = preview.purchase;
  if (!plan) return null;
  return (
    <div className="preview" aria-label="Preview">
      <div className="preview-row preview-head">
        <span>Preview</span>
        <span>{preview.cashUsed.gte('0.01') ? `incl. ${formatUsd(preview.cashUsed)} cash` : ''}</span>
      </div>
      {plan.lines.map((l) => (
        <div key={l.instrumentId} className="preview-row">
          <span>
            {nameOf(l.instrumentId)} · {l.pct.toString()}% · {formatUsd(l.targetAmount)}
          </span>
          <span>
            {formatQty(l.quantity)} @ {formatUsd(l.price, 4).replace(/(\.\d\d)00$/, '$1')}
            {preview.priceDates.get(l.instrumentId) && <span className="muted block">price of {fmtDate(preview.priceDates.get(l.instrumentId)!)}</span>}
          </span>
        </div>
      ))}
      <div className="preview-row muted">
        <span>Leftover to cash</span>
        <span>{plan.leftoverCash.lt('0.01') ? 'under $0.01' : formatUsd(plan.leftoverCash)}</span>
      </div>
    </div>
  );
}

// --- Recurring ---------------------------------------------------------------

export function RecurringRules({ data }: { data: MoneyData }) {
  const { portfolio, rules, runsByRule } = data;
  useSyncExternalStore(contributionService.subscribe, contributionService.getVersion, contributionService.getVersion);
  const today = todayLocal();
  const [form, setForm] = useState<RuleInput>({ amount: '', frequency: 'monthly', startDate: today, endDate: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof RuleInput | 'form', string>>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ContributionRule | null>(null);

  const set = (k: keyof RuleInput, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors({});
    setNotice(null);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const r = parseRule(form);
    if (!r.ok) return setErrors(r.errors);
    setBusy(true);
    try {
      await contributionRepo.createRule(portfolio.id, r.value);
      const made = await contributionService.runDue();
      setNotice(
        made > 0
          ? `Rule added. Caught up ${made} past ${made === 1 ? 'contribution' : 'contributions'} at their closing prices.`
          : 'Rule added. The next contribution runs after that day’s market close.',
      );
      setForm({ amount: '', frequency: 'monthly', startDate: today, endDate: '' });
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Saving failed.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="recurring-title">
      <h2 id="recurring-title" className="section-title">
        Recurring contributions
      </h2>
      {rules.length === 0 && <p className="muted small">None yet.</p>}
      {rules.map((rule) => (
        <RuleCard key={rule.id} rule={rule} runs={runsByRule.get(rule.id) ?? 0} onDelete={() => setConfirmDelete(rule)} />
      ))}

      <form className="stack new-rule" onSubmit={create} noValidate>
        <h3 className="sub-title">New recurring rule</h3>
        <div className="grid-2">
          <Field label="Amount ($)" error={errors.amount}>
            {(p) => <input {...p} className="input" inputMode="decimal" placeholder="500" value={form.amount} onChange={(e) => set('amount', e.target.value)} />}
          </Field>
          <Field label="How often" error={errors.frequency}>
            {(p) => (
              <select {...p} className="input" value={form.frequency} onChange={(e) => set('frequency', e.target.value)}>
                {FREQUENCIES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Start date" error={errors.startDate}>
            {(p) => <input {...p} className="input" type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} />}
          </Field>
          <Field label="End date · optional" error={errors.endDate}>
            {(p) => <input {...p} className="input" type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} />}
          </Field>
        </div>
        <p className="muted small">
          A past start date back-fills every missed contribution at that day's closing price. Weekends and market holidays move to the next trading
          day. Each one runs after that day's close.
        </p>
        {errors.form && (
          <p className="field-error" role="alert">
            {errors.form}
          </p>
        )}
        <button type="submit" className="btn btn-secondary" disabled={busy}>
          {busy ? 'Adding…' : 'Add recurring rule'}
        </button>
        {notice && (
          <p className="notice-inline notice-ok" role="status">
            {notice}
          </p>
        )}
      </form>

      <Dialog open={!!confirmDelete} title="Delete recurring rule?" onClose={() => setConfirmDelete(null)}>
        {confirmDelete && (
          <div className="stack">
            <p>
              Future contributions of {formatUsd(confirmDelete.amount)} {FREQUENCIES.find((f) => f.value === confirmDelete.frequency)?.label.toLowerCase()} stop. The{' '}
              {runsByRule.get(confirmDelete.id) ?? 0} it already made stay in the ledger.
            </p>
            <div className="row-end">
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={() => void contributionRepo.deleteRule(confirmDelete).then(() => setConfirmDelete(null))}>
                Delete rule
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}

function RuleCard({ rule, runs, onDelete }: { rule: ContributionRule; runs: number; onDelete: () => void }) {
  const status = contributionService.statusOf(rule.id);
  const next = nextScheduledDate(rule, todayLocal());
  const freq = FREQUENCIES.find((f) => f.value === rule.frequency)?.label.toLowerCase() ?? rule.frequency;
  return (
    <div className="rule-card stack-tight">
      <div className="row-between baseline">
        <span className="strong">
          {formatUsd(rule.amount)} {freq}
        </span>
        <span className={`badge ${rule.paused ? 'badge-muted' : status?.kind === 'blocked' ? 'badge-warn' : 'badge-ok'}`}>
          {rule.paused ? 'Paused' : status?.kind === 'blocked' ? 'Needs attention' : 'Active'}
        </span>
      </div>
      <span className="small muted">
        From {fmtDate(rule.startDate)}
        {rule.endDate && ` to ${fmtDate(rule.endDate)}`} · {runs} {runs === 1 ? 'buy' : 'buys'} so far
        {!rule.paused && next && ` · next ${fmtDate(next)}`}
      </span>
      {!rule.paused && status?.kind === 'waiting' && (
        <span className="small muted">Waiting for the {fmtDate(status.scheduledDate)} closing price — it runs automatically once available.</span>
      )}
      {!rule.paused && status?.kind === 'blocked' && <span className="small warn-text">{status.message}</span>}
      <div className="row-start">
        <button className="btn btn-small btn-outline" onClick={() => void contributionRepo.setPaused(rule, !rule.paused).then(() => contributionService.runDue())}>
          {rule.paused ? 'Resume' : 'Pause'}
        </button>
        <button className="btn btn-small btn-outline danger-text" onClick={onDelete}>
          Delete
        </button>
      </div>
      {rule.paused && <span className="muted small">Resuming continues from today; dates missed while paused are skipped.</span>}
    </div>
  );
}
