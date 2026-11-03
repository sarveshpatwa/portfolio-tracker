import { useEffect, useState } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { COMPARE_STORES, loadCompare, type CompareOptions, type MixSource, type SwitchCard } from '../../application/compareQueries';
import { COMPARE_PERIODS, type ComparePeriod } from '../../domain/compare/backtest';
import { RISK_FREE_RATE, type Metrics } from '../../domain/compare/metrics';
import { parseIso, type IsoDate } from '../../domain/calendar/dates';
import { switchRepo } from '../../data/repositories/switchRepo';
import { switchService } from '../../application/switchService';
import { href } from '../../app/routes';
import { LinesChart, SERIES_COLORS } from '../components/LinesChart';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dLong = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const day = (d: IsoDate) => dLong.format(parseIso(d));
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`);
const plainPct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`);
const signedUsd = (x: number) => `${x >= 0 ? '+' : '−'}${usd.format(Math.abs(x))}`;
const tone = (x: number | null | undefined) => (x === null || x === undefined || Math.abs(x) < 1e-9 ? '' : x > 0 ? 'gain' : 'loss');

const STORE_KEY = 'compareOptions';
const DEFAULTS: CompareOptions = { period: '1Y', amount: 10000, mix: 'holdings', assumeFlatBefore: false };
function savedOptions(): CompareOptions {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<CompareOptions> | null;
    return { ...DEFAULTS, ...(v ?? {}) };
  } catch {
    return DEFAULTS;
  }
}

export function CompareScreen() {
  const [opts, setOpts] = useState<CompareOptions>(savedOptions);
  const [amountText, setAmountText] = useState(String(opts.amount));
  const data = useLiveQuery(() => loadCompare(opts), COMPARE_STORES, [opts.period, opts.amount, opts.mix, opts.assumeFlatBefore]);

  const update = (patch: Partial<CompareOptions>) => {
    const next = { ...opts, ...patch };
    setOpts(next);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  };
  const amountValid = /^\d+(\.\d{1,2})?$/.test(amountText.replace(/[,$\s]/g, '')) && Number(amountText.replace(/[,$\s]/g, '')) >= 1;

  return (
    <div className="screen">
      <header className="stack-tight">
        <h1 className="screen-title">Compare</h1>
        <p className="muted small">If the same money had gone into each portfolio, which would have done best?</p>
      </header>

      <section className="card stack" aria-label="Comparison settings">
        <div className="segmented segmented-large" role="group" aria-label="Period">
          {COMPARE_PERIODS.map((p) => (
            <button key={p} aria-pressed={opts.period === p} onClick={() => update({ period: p as ComparePeriod })}>
              {p}
            </button>
          ))}
        </div>
        <div className="grid-2">
          <label className="field">
            <span className="field-label">Same amount in each ($)</span>
            <input
              className="input"
              inputMode="decimal"
              value={amountText}
              aria-invalid={amountValid ? undefined : true}
              onChange={(e) => setAmountText(e.target.value)}
              onBlur={() => amountValid && update({ amount: Number(amountText.replace(/[,$\s]/g, '')) })}
              onKeyDown={(e) => e.key === 'Enter' && amountValid && update({ amount: Number(amountText.replace(/[,$\s]/g, '')) })}
            />
            {!amountValid && <span className="field-error">Enter an amount of at least $1.</span>}
          </label>
          <div className="field">
            <span className="field-label" id="mix-label">
              Each portfolio’s mix
            </span>
            <div className="segmented" role="group" aria-labelledby="mix-label">
              {(['holdings', 'target'] as MixSource[]).map((m) => (
                <button key={m} aria-pressed={opts.mix === m} onClick={() => update({ mix: m })}>
                  {m === 'holdings' ? 'Holdings today' : 'Target allocation'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="row-start small">
          <input type="checkbox" checked={opts.assumeFlatBefore} onChange={(e) => update({ assumeFlatBefore: e.target.checked })} />
          Before an asset’s first known price, assume it was the same (good for $1.00 funds)
        </label>
      </section>

      {data.status === 'loading' && <p className="muted">Calculating…</p>}
      {data.status === 'error' && (
        <div className="card notice notice-danger" role="alert">
          Couldn’t compare: {data.error.message}
        </div>
      )}
      {data.status === 'ready' && <CompareResults data={data.data} opts={opts} />}
    </div>
  );
}

function CompareResults({ data, opts }: { data: Awaited<ReturnType<typeof loadCompare>>; opts: CompareOptions }) {
  const bt = data.backtest;
  const colorOf = new Map(data.portfolios.map((p, i) => [p.id, SERIES_COLORS[i % SERIES_COLORS.length]!]));
  const winner = bt?.results[0];
  const winnerEnd = winner?.series[winner.series.length - 1]?.value;

  return (
    <>
      {data.portfolios.length < 2 && (
        <div className="card notice" role="status">
          Add at least two portfolios (Portfolios tab) to compare them.
        </div>
      )}

      {bt && winner && winnerEnd !== undefined && (
        <section className="card stack" aria-labelledby="winner-title">
          <h2 id="winner-title" className="section-title">
            Equal-money backtest
          </h2>
          {bt.results.length > 1 && (
            <div className="winner">
              <span className="muted small">Best on equal money</span>
              <span className="winner-name">
                <span aria-hidden="true">🏆 </span>
                {winner.name}
              </span>
              <span>
                {usd0.format(opts.amount)} → <b>{usd.format(winnerEnd)}</b>{' '}
                <span className={tone(winner.metrics?.totalReturn)}>{pct(winner.metrics?.totalReturn)}</span>
              </span>
            </div>
          )}
          <p className="small">
            {usd0.format(opts.amount)} put into each portfolio’s {opts.mix === 'holdings' ? 'current holdings mix' : 'target allocation'} on{' '}
            <b>{day(bt.start)}</b>, held to {day(bt.end)} without changes.
          </p>
          {data.limitedByName && (
            <p className="small warn-text">
              Starts {day(bt.start)}, not earlier: that’s the first price for {data.limitedByName}. Tick “assume it was the same” above to go
              further back.
            </p>
          )}
          <LinesChart
            label={`Value of ${usd0.format(opts.amount)} in each portfolio from ${day(bt.start)} to ${day(bt.end)}`}
            lines={bt.results.map((r) => ({ key: r.portfolioId, name: r.name, color: colorOf.get(r.portfolioId)!, points: r.series }))}
          />
          <ol className="rank-list">
            {bt.results.map((r, i) => (
              <li key={r.portfolioId} className="rank-item">
                <div className="row-between baseline">
                  <span className="strong">
                    <span className="rank-no">{i + 1}</span>
                    <span className="legend-swatch" style={{ borderTopColor: colorOf.get(r.portfolioId) }} aria-hidden="true" /> {r.name}
                  </span>
                  <span className="strong">{usd.format(r.series[r.series.length - 1]?.value ?? 0)}</span>
                </div>
                <MetricGrid m={r.metrics} />
              </li>
            ))}
          </ol>
          <details className="details small">
            <summary>What do these mean?</summary>
            <ul className="assumptions">
              <li>
                <b>Return</b>: total change over the period. <b>Yearly</b>: the same, as a yearly rate (after 3 months).
              </li>
              <li>
                <b>Volatility</b>: how much the value swings, per year. <b>Largest drop</b>: worst fall from a high point.
              </li>
              <li>
                <b>Sharpe</b>: (yearly return − {(RISK_FREE_RATE * 100).toFixed(0)}% risk-free) ÷ volatility — return per unit of risk. Above
                1 is good, below 0 means less than cash.
              </li>
              <li>Buy and hold: no rebalancing, no new money, no fees or taxes; dividends only if they’re in the price.</li>
              <li>Hand-priced assets keep their last price between updates.</li>
            </ul>
          </details>
        </section>
      )}

      {data.excluded.length > 0 && (
        <p className="muted small">Not in the backtest: {data.excluded.map((e) => `${e.name} (${e.reason})`).join(', ')}.</p>
      )}

      {data.actual.length > 0 && (
        <section className="card stack" aria-labelledby="actual-title">
          <h2 id="actual-title" className="section-title">
            Actual track record
          </h2>
          <p className="muted small">
            Each portfolio’s real ledger — its own contributions and changes — with new money taken out (time-weighted), over the same
            period.
          </p>
          <ul className="rank-list">
            {data.actual.map(({ portfolio, perf }) => (
              <li key={portfolio.id} className="rank-item">
                <div className="row-between baseline">
                  <span className="strong">
                    <span className="legend-swatch" style={{ borderTopColor: colorOf.get(portfolio.id) }} aria-hidden="true" /> {portfolio.name}
                  </span>
                  <span className={`strong ${tone(perf?.metrics?.totalReturn)}`}>{perf?.metrics ? pct(perf.metrics.totalReturn) : '—'}</span>
                </div>
                {perf?.metrics ? (
                  <>
                    {perf.partial && <span className="muted small">since {day(perf.since)} (its start)</span>}
                    <MetricGrid m={perf.metrics} hideReturn />
                  </>
                ) : (
                  <span className="muted small">No history yet.</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card stack" aria-labelledby="switch-title">
        <div className="row-between">
          <h2 id="switch-title" className="section-title">
            Switches
          </h2>
          <a className="btn btn-small btn-outline btn-link" href={href.switchNew()}>
            Track a switch
          </a>
        </div>
        {data.switches.length === 0 ? (
          <p className="muted small">
            Moved money from one portfolio to another? Track the switch to see whether staying would have been better.
          </p>
        ) : (
          data.switches.map((c) => <SwitchCheck key={c.sw.id} card={c} />)
        )}
      </section>
    </>
  );
}

function MetricGrid({ m, hideReturn }: { m: Metrics | null; hideReturn?: boolean }) {
  if (!m) return <span className="muted small">Not enough data in this period.</span>;
  return (
    <dl className="metric-grid">
      {!hideReturn && (
        <div>
          <dt>Return</dt>
          <dd className={tone(m.totalReturn)}>{pct(m.totalReturn)}</dd>
        </div>
      )}
      <div>
        <dt>Yearly</dt>
        <dd>{m.cagr === null ? 'after 3 months' : pct(m.cagr)}</dd>
      </div>
      <div>
        <dt>Volatility</dt>
        <dd>{plainPct(m.volatility)}</dd>
      </div>
      <div>
        <dt>Largest drop</dt>
        <dd>{m.maxDrawdown === 0 ? 'none' : pct(m.maxDrawdown)}</dd>
      </div>
      <div>
        <dt>Sharpe</dt>
        <dd>{m.sharpe === null ? '—' : m.sharpe.toFixed(2)}</dd>
      </div>
    </dl>
  );
}

function SwitchCheck({ card }: { card: SwitchCard }) {
  const { sw, fromName, toName, summary } = card;
  const [confirm, setConfirm] = useState(false);
  // Optimistic: the box flips at once; the saved value catches up a moment later.
  const [mirrorOn, setMirrorOn] = useState(sw.mirrorContributions);
  useEffect(() => setMirrorOn(sw.mirrorContributions), [sw.mirrorContributions]);
  const problem = switchService.problems.get(sw.id);
  return (
    <article className="switch-card stack-tight" aria-label={`Switch from ${fromName} to ${toName}`}>
      <div className="row-between baseline wrap">
        <span className="strong">
          {fromName} → {toName}
        </span>
        <span className="muted small">switched {day(sw.switchDate)}</span>
      </div>
      {!summary ? (
        <p className="muted small">No values yet on or after the switch date.</p>
      ) : (
        <>
          <p className="switch-verdict">
            <span className={`strong ${tone(summary.difference)}`}>
              {signedUsd(summary.difference)} ({pct(summary.differencePct)})
            </span>{' '}
            <span className="small">
              {Math.abs(summary.difference) < 0.005 ? 'same as staying' : summary.difference > 0 ? 'better than staying' : 'worse than staying'}
            </span>
          </p>
          <dl className="metric-grid">
            <div>
              <dt>If you’d stayed</dt>
              <dd>{usd.format(summary.baselineNow)}</dd>
            </div>
            <div>
              <dt>{toName} now</dt>
              <dd>{usd.format(summary.newNow)}</dd>
            </div>
            <div>
              <dt>Old, time-weighted</dt>
              <dd className={tone(summary.baselineReturn)}>{pct(summary.baselineReturn)}</dd>
            </div>
            <div>
              <dt>New, time-weighted</dt>
              <dd className={tone(summary.newReturn)}>{pct(summary.newReturn)}</dd>
            </div>
            <div>
              <dt>On switch day</dt>
              <dd>
                {usd.format(summary.baselineStart)} → {usd.format(summary.newStart)}
              </dd>
            </div>
            {summary.newAfterFee !== undefined && (
              <div>
                <dt>New after fees</dt>
                <dd>{usd.format(summary.newAfterFee)}</dd>
              </div>
            )}
          </dl>
          {!mirrorOn && (
            <p className="muted small">New money isn’t mirrored, so compare the time-weighted returns if you added money to one side.</p>
          )}
          {card.fromCheck && <StatementLine label={`${fromName} vs statement`} check={card.fromCheck} />}
          {card.toCheck && <StatementLine label={`${toName} vs statement`} check={card.toCheck} />}
          <LinesChart
            label={`${fromName} and ${toName} since ${day(sw.switchDate)}`}
            lines={[
              { key: 'new', name: toName, color: SERIES_COLORS[0]!, points: summary.newSeries },
              { key: 'old', name: `${fromName} (stayed)`, color: SERIES_COLORS[1]!, dashed: true, points: summary.baselineSeries },
            ]}
          />
        </>
      )}
      {problem && <p className="small warn-text">{problem}</p>}
      <div className="row-between wrap">
        <label className="row-start small">
          <input
            type="checkbox"
            checked={mirrorOn}
            onChange={(e) => {
              const on = e.target.checked;
              setMirrorOn(on);
              void switchRepo.setMirror(sw, on).then(() => switchService.runMirrors());
            }}
          />
          Mirror new money into {fromName}
        </label>
        {confirm ? (
          <span className="row-end">
            <button className="btn btn-small btn-ghost" onClick={() => setConfirm(false)}>
              Keep
            </button>
            <button className="btn btn-small btn-danger" onClick={() => void switchRepo.remove(sw)}>
              Remove link
            </button>
          </span>
        ) : (
          <button className="btn btn-small btn-ghost" onClick={() => setConfirm(true)}>
            Remove…
          </button>
        )}
      </div>
      {confirm && <p className="muted small">Only the link is removed; both portfolios and their ledgers stay.</p>}
    </article>
  );
}

function StatementLine({ label, check }: { label: string; check: { differencePct: { toNumber(): number }; withinTolerance: boolean } }) {
  const d = check.differencePct.toNumber();
  return (
    <p className={`small ${check.withinTolerance ? 'muted' : 'warn-text'}`}>
      {check.withinTolerance ? '✓' : '⚠'} {label}: {check.withinTolerance ? 'matches' : 'differs'} ({pct(d, 2)})
      {!check.withinTolerance && ' — check the units entered for the switch date.'}
    </p>
  );
}
