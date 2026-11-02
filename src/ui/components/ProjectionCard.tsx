import { useState } from 'react';
import { MIN_DAYS_FOR_CAGR, type DayValue } from '../../domain/portfolio/history';
import { project, PROJECTION_YEARS } from '../../domain/portfolio/projection';
import { formatUsd } from '../../domain/money/format';
import { Dec } from '../../domain/money/decimal';
import { parseIso } from '../../domain/calendar/dates';

const money = (n: number) => formatUsd(Dec.from(n.toFixed(2)));
const dLong = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/**
 * "Estimate": straight extrapolation of the portfolio's own past annualised
 * return, plus running recurring contributions. Assumptions are always shown.
 */
export function ProjectionCard({
  series,
  annual,
  yearlyContribution,
}: {
  series: DayValue[];
  annual: { rate: number; days: number } | null;
  yearlyContribution: number;
}) {
  const [includeContrib, setIncludeContrib] = useState(true);
  const current = series[series.length - 1]?.value ?? 0;

  return (
    <section className="card stack" aria-labelledby="proj-title">
      <div className="row-start">
        <h2 id="proj-title" className="section-title">
          Projection
        </h2>
        <span className="badge badge-warn">Estimate</span>
      </div>

      {!annual || current <= 0 ? (
        <p className="muted small">
          Not enough history yet. Projections appear after about 3 months
          {series.length > 0 && (() => {
            const days = Math.max(0, Math.round((parseIso(series[series.length - 1]!.date).getTime() - parseIso(series[0]!.date).getTime()) / 86_400_000));
            return ` (${days} of ${MIN_DAYS_FOR_CAGR} days so far)`;
          })()}
          , so a few lucky or unlucky weeks don’t get stretched into a yearly rate.
        </p>
      ) : (
        <ProjectionTable
          current={current}
          rate={annual.rate}
          days={annual.days}
          since={series[0]!.date}
          perYear={includeContrib ? yearlyContribution : 0}
          hasContrib={yearlyContribution > 0}
          includeContrib={includeContrib}
          setIncludeContrib={setIncludeContrib}
        />
      )}
    </section>
  );
}

function ProjectionTable(props: {
  current: number;
  rate: number;
  days: number;
  since: string;
  perYear: number;
  hasContrib: boolean;
  includeContrib: boolean;
  setIncludeContrib: (v: boolean) => void;
}) {
  const { rate: historyRate, days, since, current, perYear, hasContrib, includeContrib, setIncludeContrib } = props;
  const [custom, setCustom] = useState('');
  const customRate = custom.trim() === '' ? null : Number(custom) / 100;
  const customOk = customRate !== null && Number.isFinite(customRate) && customRate > -0.5 && customRate < 0.5;
  const rate = customOk ? customRate : historyRate;
  const rows = project(current, rate, perYear, PROJECTION_YEARS);
  const months = Math.round(days / 30.44);
  const extreme = !customOk && Math.abs(rate) > 0.3;
  return (
    <>
      <div className="row-start wrap small">
        <label htmlFor="proj-rate">Growth rate</label>
        <input
          id="proj-rate"
          className="input input-narrow"
          inputMode="decimal"
          value={custom}
          placeholder={(historyRate * 100).toFixed(1)}
          aria-describedby="proj-rate-hint"
          onChange={(e) => setCustom(e.target.value)}
        />
        <span>% a year</span>
        {custom && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setCustom('')}>
            Use history
          </button>
        )}
      </div>
      <p id="proj-rate-hint" className="muted small">
        {customOk
          ? 'Using your rate instead of this portfolio’s history.'
          : custom.trim()
            ? 'Enter a rate between −50 and 50. Using history meanwhile.'
            : 'Empty = this portfolio’s own history. Try e.g. 5 or 7 to compare.'}
      </p>
      <table className="proj-table">
        <thead>
          <tr>
            <th scope="col">In</th>
            <th scope="col">Value</th>
            <th scope="col">New money</th>
            <th scope="col">Growth</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.years}>
              <th scope="row">{r.years === 1 ? '1 year' : `${r.years} years`}</th>
              <td className="strong">{money(r.value)}</td>
              <td>{money(r.contributed)}</td>
              <td className={r.growth >= 0 ? 'gain' : 'loss'}>{`${r.growth >= 0 ? '+' : '−'}${money(Math.abs(r.growth))}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasContrib && (
        <label className="row-start small">
          <input type="checkbox" checked={includeContrib} onChange={(e) => setIncludeContrib(e.target.checked)} />
          Include recurring contributions
        </label>
      )}
      <div className="stack-tight small">
        <b>Assumptions</b>
        <ul className="assumptions">
          <li>
            {customOk ? (
              <>
                Grows <b>{(rate * 100).toFixed(1)}% a year</b> (your rate), every year, with no ups and downs.
              </>
            ) : (
              <>
                Grows <b>{(rate * 100).toFixed(1)}% a year</b> — this portfolio’s annualised time-weighted return since{' '}
                {dLong.format(parseIso(since))} ({months < 24 ? `${months} months` : `${(days / 365.25).toFixed(1)} years`}), every year, with no
                ups and downs.
              </>
            )}
          </li>
          <li>{perYear > 0 ? `${money(perYear)} a year of recurring contributions continues.` : 'No new money is added.'}</li>
          <li>No fees, taxes or withdrawals.</li>
          <li>Past returns don’t predict future returns — real results will differ.</li>
        </ul>
        {days < 365 && !customOk && <p className="warn-text">Based on less than a year of history: treat this as very rough.</p>}
        {extreme && <p className="warn-text">That yearly rate is unusually {rate > 0 ? 'high' : 'low'} and unlikely to last.</p>}
      </div>
    </>
  );
}
