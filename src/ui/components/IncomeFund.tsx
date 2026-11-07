import { useState } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { incomeService, loadIncomeStatus } from '../../application/incomeService';
import { linkPriceService } from '../../application/linkPriceService';
import { assetRepo } from '../../data/repositories/assetRepo';
import { S } from '../../data/db/schema';
import { Dec } from '../../domain/money/decimal';
import { isIsoDate, parseIso, todayInNewYork } from '../../domain/calendar/dates';
import { payableDate, monthOf } from '../../domain/income/dividends';
import type { Instrument } from '../../domain/types';
import { Field } from './Field';

const STORES = [S.instruments, S.transactions, S.prices] as const;
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (m: string) => monthName.format(parseIso(`${m}-01`));

/** One line under the holding: this month's estimated dividend so far. */
export function IncomeLine({ fund, portfolioId }: { fund: Instrument; portfolioId: string }) {
  const s = useLiveQuery(() => loadIncomeStatus(fund, portfolioId), STORES, [fund, portfolioId]);
  if (s.status !== 'ready' || !s.data.accrued) return null;
  const m = s.data.accrued.month;
  return (
    <span className="small muted">
      ≈ {usd(s.data.accrued.amount)} dividend earned in {monthLabel(m).split(' ')[0]} so far (est., paid {dayFmt.format(parseIso(payableDate(m)))})
    </span>
  );
}

/** Asset options: income-fund tracking, yield updates, statement corrections. */
export function IncomeEditor({ fund, portfolioId }: { fund: Instrument; portfolioId: string }) {
  const today = todayInNewYork();
  const s = useLiveQuery(() => loadIncomeStatus(fund, portfolioId), STORES, [fund, portfolioId]);
  const [on, setOn] = useState(!!fund.income);
  const [pct, setPct] = useState('');
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const saveYield = async () => {
    setNote(null);
    const v = Number(pct.trim().replace('%', ''));
    if (!pct.trim() || !Number.isFinite(v) || v < 0 || v > 25) return setError('Enter the 7-day SEC yield, e.g. 3.89.');
    if (!isIsoDate(date) || date > today) return setError('Choose a date that isn’t in the future.');
    setError(null);
    await assetRepo.setIncomeYield(fund.id, { date, pct: String(v), source: 'typed' });
    setPct('');
    setNote(`Saved ${v}% from ${dayFmt.format(parseIso(date))}.`);
    void incomeService.runDue();
  };

  const linked = !!fund.priceLink;
  const current = s.status === 'ready' ? s.data.currentYield : null;
  const kind = (days?: 7 | 30) => (days ? `${days}-day SEC yield` : 'yield');
  const typedForm = (
    <div className="stack-tight">
      <div className="grid-2">
        <Field label="7-day SEC yield (%)" error={error ?? undefined} hint={linked ? 'Only if you want to override Vanguard’s figure.' : 'From the fund’s Vanguard page (30-day for stable value funds). Update it every week or so.'}>
          {(p) => <input {...p} className="input" inputMode="decimal" placeholder="e.g. 3.89" value={pct} onChange={(e) => setPct(e.target.value)} />}
        </Field>
        <Field label="Yield as of">
          {(p) => <input {...p} className="input" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
      </div>
      <button type="button" className="btn btn-small btn-outline" onClick={() => void saveYield()}>
        Save yield
      </button>
    </div>
  );

  return (
    <section className="stack-tight">
      <label className="row-start small">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const v = e.target.checked;
            setOn(v);
            if (!v && fund.income) void assetRepo.setIncomeYield(fund.id, undefined);
            if (v && !fund.income) {
              void assetRepo.enableIncome(fund.id).then(() => (linked ? linkPriceService.runDue({ force: true, only: fund.id }) : undefined));
            }
          }}
        />
        <span>
          <b>$1.00 income fund</b> (money market / stable value): estimate the monthly dividend paid as new units
        </span>
      </label>
      {on && (
        <div className="stack-tight income-box">
          {current ? (
            <p className="small">
              Using a <b>{current.pct}%</b> {kind(current.days)} ({current.source === 'fetched' ? 'from Vanguard' : 'typed'}, as of{' '}
              {dayFmt.format(parseIso(current.date))}).
              {s.status === 'ready' && s.data.accrued && (
                <>
                  {' '}
                  {monthLabel(s.data.accrued.month).split(' ')[0]} so far: ≈ <b>{usd(s.data.accrued.amount)}</b>, paid{' '}
                  {dayFmt.format(parseIso(payableDate(monthOf(today))))}.
                </>
              )}
            </p>
          ) : linked ? (
            <p className="small muted">Waiting for the yield from Vanguard — it comes with the next price fetch.</p>
          ) : null}
          {linked && <p className="muted small">The yield is fetched with the daily Vanguard price (fund {fund.priceLink!.fundId}); each day’s estimate uses the yield in effect that day.</p>}
          {linked ? (
            <details className="details small">
              <summary>Type a yield instead</summary>
              {typedForm}
            </details>
          ) : (
            <>
              {typedForm}
              <p className="muted small">Tip: add the fund’s Vanguard code (above) and the yield is fetched automatically.</p>
            </>
          )}
          {note && (
            <p className="small" role="status">
              {note}
            </p>
          )}
          {s.status === 'ready' && s.data.dividends.length > 0 && (
            <div className="stack-tight">
              <b className="small">Dividends</b>
              <ul className="dividend-list">
                {s.data.dividends.map((t) => (
                  <DividendRow key={t.id} tx={t} />
                ))}
              </ul>
            </div>
          )}
          <p className="muted small">
            On the first business day of each month the estimate is added as new units, marked “estimated”. Enter the amount from your
            statement to replace it. Dividends you entered yourself before turning this on aren’t touched.
          </p>
        </div>
      )}
    </section>
  );
}

function DividendRow({ tx }: { tx: { id: string; date: string; quantity?: string; estimated?: boolean } & Parameters<typeof assetRepo.correctDividend>[0] }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const month = tx.id.split(':').pop()!;
  const save = async () => {
    const v = Dec.tryParse(text.trim().replace(/[$,]/g, ''));
    if (!v || !v.isPositive()) return setError('Enter the units from your statement.');
    setError(null);
    try {
      await assetRepo.correctDividend(tx, v);
      setText('');
    } catch {
      setError('Couldn’t save that amount.');
    }
  };
  return (
    <li className="stack-tight">
      <div className="row-between">
        <span className="small">
          {monthLabel(month)} · paid {dayFmt.format(parseIso(tx.date))}
        </span>
        <span className="small">
          <b>{tx.quantity}</b> units {tx.estimated ? <span className="badge badge-neutral">estimated</span> : <span className="badge badge-info">actual</span>}
        </span>
      </div>
      {tx.estimated && (
        <div className="row-start">
          <input
            className="input input-narrow"
            inputMode="decimal"
            aria-label={`Actual dividend units for ${monthLabel(month)}`}
            placeholder="actual"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="button" className="btn btn-small btn-outline" onClick={() => void save()}>
            Use statement amount
          </button>
        </div>
      )}
      {error && <span className="field-error">{error}</span>}
    </li>
  );
}
