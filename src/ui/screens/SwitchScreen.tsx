import { useState } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { COMPARE_STORES, loadSwitchSide, type SwitchSide } from '../../application/compareQueries';
import { portfolioRepo } from '../../data/repositories/portfolioRepo';
import { switchRepo } from '../../data/repositories/switchRepo';
import { switchService } from '../../application/switchService';
import { newId, nextSeq } from '../../data/ids';
import { Dec } from '../../domain/money/decimal';
import { formatUsd } from '../../domain/money/format';
import { isIsoDate, todayLocal, type IsoDate } from '../../domain/calendar/dates';
import { checkAgainstStatement, OpeningError, openingFromUnits, openingTransactions, switchCost, type OpeningPositions } from '../../domain/switches/opening';
import type { PricePoint, Transaction } from '../../domain/types';
import { href, navigate } from '../../app/routes';
import { Field } from '../components/Field';

type SideInput = { units: Record<string, string>; prices: Record<string, string>; cash: string; statement: string };
const emptySide = (): SideInput => ({ units: {}, prices: {}, cash: '', statement: '' });
const pos = (t: string) => {
  const v = Dec.tryParse(t.trim().replace(/[$,]/g, ''));
  return v && v.isPositive() ? v : null;
};

/** What a side would open with, or why it can't. */
function sideOpening(side: SwitchSide, input: SideInput): { opening?: OpeningPositions; value: Dec | null; error?: string } {
  if (side.usesLedger) return { value: Dec.from(side.ledgerValue.toFixed(2)) };
  const holdings: { instrumentId: string; quantity: Dec; price: Dec }[] = [];
  for (const a of side.assets) {
    const q = (input.units[a.instrumentId] ?? '').trim();
    if (!q) continue;
    const quantity = pos(q);
    if (!quantity) return { value: null, error: `Units for ${a.name} must be a number above 0.` };
    const typed = input.prices[a.instrumentId];
    const price = a.manual && typed !== undefined && typed.trim() !== '' ? pos(typed) : (a.price?.price ?? null);
    if (!price) return { value: null, error: a.manual ? `Enter ${a.name}’s price on the switch date.` : `No closing price for ${a.name} on or before that date yet.` };
    holdings.push({ instrumentId: a.instrumentId, quantity, price });
  }
  const cash = input.cash.trim() ? pos(input.cash) : Dec.ZERO;
  if (cash === null) return { value: null, error: 'Cash must be a number above 0, or empty.' };
  try {
    const opening = openingFromUnits(holdings, cash);
    return { opening, value: opening.total };
  } catch (e) {
    return { value: null, error: e instanceof OpeningError ? e.message : 'Check the units.' };
  }
}

export function SwitchScreen() {
  const today = todayLocal();
  const portfolios = useLiveQuery(() => portfolioRepo.list(), COMPARE_STORES);
  const [date, setDate] = useState<IsoDate>(today);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [inputs, setInputs] = useState<{ from: SideInput; to: SideInput }>({ from: emptySide(), to: emptySide() });
  const [mirror, setMirror] = useState(true);
  const [oneTimeCost, setOneTimeCost] = useState('');
  const [annualFee, setAnnualFee] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dateOk = isIsoDate(date) && date <= today;

  const from = useLiveQuery(() => (fromId && dateOk ? loadSwitchSide(fromId, date) : Promise.resolve(null)), COMPARE_STORES, [fromId, date]);
  const to = useLiveQuery(() => (toId && dateOk ? loadSwitchSide(toId, date) : Promise.resolve(null)), COMPARE_STORES, [toId, date]);
  const fromSide = from.status === 'ready' ? from.data : null;
  const toSide = to.status === 'ready' ? to.data : null;
  const fromOpen = fromSide ? sideOpening(fromSide, inputs.from) : null;
  const toOpen = toSide ? sideOpening(toSide, inputs.to) : null;

  const setSide = (which: 'from' | 'to', patch: Partial<SideInput>) => setInputs((x) => ({ ...x, [which]: { ...x[which], ...patch } }));

  const save = async () => {
    setError(null);
    if (!dateOk) return setError('Choose a switch date that isn’t in the future.');
    if (!fromSide || !toSide) return setError('Choose both portfolios.');
    if (fromSide.portfolio.id === toSide.portfolio.id) return setError('Choose two different portfolios.');
    for (const [o, s] of [
      [fromOpen, fromSide],
      [toOpen, toSide],
    ] as const) {
      if (o?.error) return setError(`${s.portfolio.name}: ${o.error}`);
    }
    for (const [label, t] of [
      ['Old statement value', inputs.from.statement],
      ['New statement value', inputs.to.statement],
      ['One-time cost', oneTimeCost],
    ] as const) {
      if (t.trim() && !pos(t)) return setError(`${label} must be a number above 0, or empty.`);
    }
    if (annualFee.trim() && !(Number(annualFee) > 0 && Number(annualFee) < 20)) return setError('Yearly fee must be between 0 and 20%.');

    const now = new Date().toISOString();
    const openings: Transaction[] = [];
    const pricePoints: PricePoint[] = [];
    for (const [o, s, inp] of [
      [fromOpen, fromSide, inputs.from],
      [toOpen, toSide, inputs.to],
    ] as const) {
      if (!o?.opening) continue;
      openings.push(...openingTransactions(o.opening, { portfolioId: s.portfolio.id, date, newId, nextSeq, now }, 'Switch opening'));
      for (const a of s.assets) {
        const typed = inp.prices[a.instrumentId];
        if (!a.manual || !typed?.trim() || !inp.units[a.instrumentId]?.trim()) continue;
        const price = pos(typed);
        if (price && !(a.price && a.price.date === date && a.price.price.eq(price))) {
          pricePoints.push({ instrumentId: a.instrumentId, date, close: price.toString(), source: 'manual', updatedAt: now });
        }
      }
    }
    setBusy(true);
    try {
      await switchRepo.create({
        switchDate: date,
        fromPortfolioId: fromSide.portfolio.id,
        toPortfolioId: toSide.portfolio.id,
        mirrorContributions: mirror,
        openings,
        pricePoints,
        ...(inputs.from.statement.trim() ? { fromStatementValue: pos(inputs.from.statement)!.toString() } : {}),
        ...(inputs.to.statement.trim() ? { toStatementValue: pos(inputs.to.statement)!.toString() } : {}),
        ...(oneTimeCost.trim() ? { oneTimeCost: pos(oneTimeCost)!.toString() } : {}),
        ...(annualFee.trim() ? { annualFeePct: String(Number(annualFee)) } : {}),
      });
      void switchService.runMirrors();
      navigate(href.compare());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Saving failed.');
      setBusy(false);
    }
  };

  const list = portfolios.status === 'ready' ? portfolios.data : [];
  const cost = fromOpen?.value && toOpen?.value ? switchCost(fromOpen.value, toOpen.value) : null;

  return (
    <div className="screen">
      <a className="back-link" href={href.compare()}>
        ‹ Compare
      </a>
      <header className="stack-tight">
        <h1 className="screen-title">Track a switch</h1>
        <p className="muted small">
          Compare the portfolio you moved to with the one you left, both from the switch date. Set up both portfolios and their assets
          first (Portfolios tab).
        </p>
      </header>

      <section className="card stack">
        <Field label="Switch date">
          {(p) => <input {...p} className="input" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <div className="grid-2">
          <Field label="Old portfolio (what you left)">
            {(p) => (
              <select {...p} className="input" value={fromId} onChange={(e) => setFromId(e.target.value)}>
                <option value="">Choose…</option>
                {list.map((x) => (
                  <option key={x.id} value={x.id} disabled={x.id === toId}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="New portfolio (where the money went)">
            {(p) => (
              <select {...p} className="input" value={toId} onChange={(e) => setToId(e.target.value)}>
                <option value="">Choose…</option>
                {list.map((x) => (
                  <option key={x.id} value={x.id} disabled={x.id === fromId}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </section>

      {fromSide && <SideEditor title="Old portfolio on the switch date" side={fromSide} input={inputs.from} result={fromOpen!} date={date} onChange={(p) => setSide('from', p)} />}
      {toSide && <SideEditor title="New portfolio on the switch date" side={toSide} input={inputs.to} result={toOpen!} date={date} onChange={(p) => setSide('to', p)} />}

      {fromSide && toSide && (
        <section className="card stack">
          {cost && (
            <p className="small">
              Switch day: {formatUsd(fromOpen!.value!)} → {formatUsd(toOpen!.value!)}
              {!cost.cost.isZero() && (
                <>
                  {' '}
                  ({cost.cost.isPositive() ? 'lost' : 'gained'} {formatUsd(cost.cost.abs())} on the day)
                </>
              )}
            </p>
          )}
          <label className="row-start small">
            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
            Mirror new money: whenever I add money to {toSide.portfolio.name}, add the same to {fromSide.portfolio.name} (in its own mix)
          </label>
          <details className="details small">
            <summary>Costs (optional)</summary>
            <p className="muted">Shown as “after fees” on the switch check; your ledgers aren’t changed.</p>
            <div className="grid-2">
              <Field label="One-time cost of switching ($)">
                {(p) => <input {...p} className="input" inputMode="decimal" value={oneTimeCost} placeholder="None" onChange={(e) => setOneTimeCost(e.target.value)} />}
              </Field>
              <Field label="Yearly advisor/other fee (%)">
                {(p) => <input {...p} className="input" inputMode="decimal" value={annualFee} placeholder="None" onChange={(e) => setAnnualFee(e.target.value)} />}
              </Field>
            </div>
          </details>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-large" disabled={busy} onClick={() => void save()}>
            Save switch
          </button>
        </section>
      )}
    </div>
  );
}

function SideEditor({
  title,
  side,
  input,
  result,
  date,
  onChange,
}: {
  title: string;
  side: SwitchSide;
  input: SideInput;
  result: { value: Dec | null; error?: string };
  date: IsoDate;
  onChange: (p: Partial<SideInput>) => void;
}) {
  const statement = input.statement.trim() ? pos(input.statement) : null;
  const check = statement && result.value ? checkAgainstStatement(result.value, statement) : null;
  return (
    <section className="card stack" aria-label={`${title}: ${side.portfolio.name}`}>
      <h2 className="section-title">
        {title} · <span className="normal">{side.portfolio.name}</span>
      </h2>
      {side.usesLedger ? (
        <p className="small">
          Uses what’s already in its ledger: <b>{formatUsd(Dec.from(side.ledgerValue.toFixed(2)))}</b> on {date} ({side.ledgerHoldings}{' '}
          {side.ledgerHoldings === 1 ? 'holding' : 'holdings'}).
        </p>
      ) : side.assets.length === 0 ? (
        <p className="warn-text small">This portfolio has no assets. Add them first (no starting units needed), then come back.</p>
      ) : (
        <>
          <p className="muted small">Units held on the switch date (leave empty for assets not held then).</p>
          {side.assets.map((a) => (
            <div key={a.instrumentId} className="grid-2 switch-line">
              <Field label={`${a.name} units`}>
                {(p) => (
                  <input
                    {...p}
                    className="input"
                    inputMode="decimal"
                    value={input.units[a.instrumentId] ?? ''}
                    onChange={(e) => onChange({ units: { ...input.units, [a.instrumentId]: e.target.value } })}
                  />
                )}
              </Field>
              {a.manual ? (
                <Field label={`${a.name} price ($)`}>
                  {(p) => (
                    <input
                      {...p}
                      className="input"
                      inputMode="decimal"
                      placeholder={a.price ? a.price.price.toString() : 'price'}
                      value={input.prices[a.instrumentId] ?? ''}
                      onChange={(e) => onChange({ prices: { ...input.prices, [a.instrumentId]: e.target.value } })}
                    />
                  )}
                </Field>
              ) : (
                <div className="field">
                  <span className="field-label">Close</span>
                  <span className="small">{a.price ? `${formatUsd(a.price.price, 4)} (${a.price.date})` : 'not downloaded yet'}</span>
                </div>
              )}
            </div>
          ))}
          <Field label="Cash ($)">
            {(p) => <input {...p} className="input" inputMode="decimal" placeholder="0" value={input.cash} onChange={(e) => onChange({ cash: e.target.value })} />}
          </Field>
          {result.error ? <p className="small warn-text">{result.error}</p> : result.value && <p className="small">Total: <b>{formatUsd(result.value)}</b></p>}
        </>
      )}
      <Field label="Statement value on that date ($, optional)" hint="To check the numbers: more than 1% off is flagged.">
        {(p) => <input {...p} className="input" inputMode="decimal" value={input.statement} onChange={(e) => onChange({ statement: e.target.value })} />}
      </Field>
      {check && (
        <p className={`small ${check.withinTolerance ? '' : 'warn-text'}`} role="status">
          {check.withinTolerance ? '✓ Matches the statement' : '⚠ Differs from the statement'} ({check.differencePct.mul(100).toFixed(2)}%)
        </p>
      )}
    </section>
  );
}
