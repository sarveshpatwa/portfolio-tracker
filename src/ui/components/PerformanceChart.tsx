import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { RANGES, rangeOf, type DayValue, type RangeKey } from '../../domain/portfolio/history';
import { formatUsd } from '../../domain/money/format';
import { Dec } from '../../domain/money/decimal';
import { parseIso, type IsoDate } from '../../domain/calendar/dates';

/*
 * Performance chart: portfolio value (solid accent line) vs amount invested
 * (dashed grey step line — a reference, not a competing series). The gap is
 * the gain. Hand-drawn SVG: no library, works offline.
 *
 * Interaction: tap or drag on the chart (or focus it and use ←/→) to read a
 * day's numbers in the readout above; otherwise the readout shows the latest day.
 */

const H = 190;
const PAD = { top: 10, right: 8, bottom: 22, left: 8 };
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const dShort = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dLong = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dWeek = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtDate = (d: IsoDate, long = false) => (long ? dLong : dShort).format(parseIso(d));
const money = (n: number) => formatUsd(Dec.from(n.toFixed(2)));
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
const pct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(2)}%`;

const RANGE_WORDS: Record<RangeKey, string> = { '1D': 'today', '1W': 'in 1 week', '1M': 'in 1 month', '1Y': 'in 1 year', All: 'since start' };
const STORAGE_KEY = 'chartRange';

function savedRange(): RangeKey {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return (RANGES as readonly string[]).includes(v ?? '') ? (v as RangeKey) : '1Y';
  } catch {
    return '1Y';
  }
}

export function PerformanceChart({ series }: { series: DayValue[] }) {
  const [range, setRange] = useState<RangeKey>(savedRange);
  const result = useMemo(() => rangeOf(series, range), [series, range]);

  const choose = (r: RangeKey) => {
    setRange(r);
    try {
      localStorage.setItem(STORAGE_KEY, r);
    } catch {
      /* private mode: just don't remember */
    }
  };

  if (series.length === 0 || !result) {
    return (
      <section className="card stack-tight" aria-labelledby="perf-title">
        <h2 id="perf-title" className="section-title">
          Performance
        </h2>
        <p className="muted small">The chart starts once the portfolio has money or holdings.</p>
      </section>
    );
  }

  const { points, returnPct, gainChange, partial } = result;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const tone = gainChange > 0.004 ? 'gain' : gainChange < -0.004 ? 'loss' : 'muted';
  const sinceText =
    range === '1D'
      ? points.length < 2
        ? 'no previous close yet'
        : `${dWeek.format(parseIso(end.date))} vs previous close`
      : partial
        ? `since start, ${fmtDate(series[0]!.date)}`
        : RANGE_WORDS[range];

  return (
    <section className="card stack" aria-labelledby="perf-title">
      <div className="row-between wrap">
        <h2 id="perf-title" className="section-title">
          Performance
        </h2>
        <div className="segmented" role="group" aria-label="Chart range">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => choose(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <p className="perf-summary" aria-live="polite">
        <span className={`strong ${tone === 'muted' ? '' : tone}`}>
          {pct(returnPct)} · {signed(gainChange)}
        </span>{' '}
        <span className="muted small">{sinceText}</span>
      </p>

      {range === '1D' ? (
        <OneDay start={start} end={end} />
      ) : (
        <Chart points={points} longDates={range === 'All' || range === '1Y'} />
      )}
      <p className="muted small">
        Return is time-weighted: money you add isn’t counted as growth. The dollar figure is the change in gain (market
        movement only).
      </p>
    </section>
  );
}

function OneDay({ start, end }: { start: DayValue; end: DayValue }) {
  const added = end.invested - start.invested;
  return (
    <dl className="oneday">
      <div>
        <dt>Previous close · {fmtDate(start.date)}</dt>
        <dd>{money(start.value)}</dd>
      </div>
      <div>
        <dt>Latest · {fmtDate(end.date)}</dt>
        <dd>{money(end.value)}</dd>
      </div>
      {Math.abs(added) >= 0.01 && (
        <div>
          <dt>Money added</dt>
          <dd>{signed(added)}</dd>
        </div>
      )}
      <p className="muted small">The free data plan has no minute-by-minute prices, so 1D is a summary rather than a line.</p>
    </dl>
  );
}

function Chart({ points, longDates }: { points: DayValue[]; longDates: boolean }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setWidth(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setActive(null), [points]);

  const geo = useMemo(() => {
    const values = points.flatMap((p) => [p.value, p.invested]);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi - lo < 1) {
      hi += 1;
      lo -= 1;
    }
    const pad = (hi - lo) * 0.08;
    const allPositive = lo >= 0;
    lo -= pad;
    if (allPositive && lo < 0) lo = 0; // don't show negative dollars on the axis
    hi += pad;
    const innerW = width - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const n = points.length;
    const x = (i: number) => PAD.left + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;
    const valuePath = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    // Invested changes in steps (on contribution days), so draw it as a step line.
    let investedPath = '';
    points.forEach((p, i) => {
      if (i === 0) investedPath = `M${x(0).toFixed(1)},${y(p.invested).toFixed(1)}`;
      else investedPath += `H${x(i).toFixed(1)}V${y(p.invested).toFixed(1)}`;
    });
    const ticks = [lo + (hi - lo) * 0.15, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.85];
    return { x, y, valuePath, investedPath, ticks, innerW };
  }, [points, width]);

  const pick = (clientX: number) => {
    const el = box.current;
    if (!el || points.length === 0) return;
    const rect = el.getBoundingClientRect();
    const rel = (clientX - rect.left - PAD.left) / geo.innerW;
    setActive(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  };
  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (e.type === 'pointerdown') (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (e.type === 'pointerdown' || e.buttons > 0 || e.pointerType === 'mouse') pick(e.clientX);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = active ?? points.length - 1;
    if (e.key === 'ArrowLeft') setActive(Math.max(0, cur - 1));
    else if (e.key === 'ArrowRight') setActive(Math.min(points.length - 1, cur + 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(points.length - 1);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };

  const idx = active ?? points.length - 1;
  const p = points[idx]!;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const gain = p.value - p.invested;

  return (
    <div className="stack-tight">
      <div className="perf-readout" aria-live="polite">
        <span className="muted small">{fmtDate(p.date, true)}</span>
        <span>
          <span className="legend-swatch legend-value" aria-hidden="true" /> Value <b>{money(p.value)}</b>
        </span>
        <span>
          <span className="legend-swatch legend-invested" aria-hidden="true" /> Invested <b>{money(p.invested)}</b>
        </span>
        <span>
          Gain <b className={gain > 0.004 ? 'gain' : gain < -0.004 ? 'loss' : ''}>{signed(gain)}</b>
        </span>
      </div>
      <div ref={box} className="perf-chart">
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          tabIndex={0}
          aria-label={`Value from ${money(first.value)} on ${fmtDate(first.date, true)} to ${money(last.value)} on ${fmtDate(last.date, true)}; invested ${money(last.invested)}. Use left and right arrow keys to read each day.`}
          onPointerDown={onPointer}
          onPointerMove={onPointer}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
        >
          {geo.ticks.map((t) => (
            <g key={t}>
              <line className="perf-grid" x1={PAD.left} x2={width - PAD.right} y1={geo.y(t)} y2={geo.y(t)} />
              <text className="perf-axis" x={PAD.left + 2} y={geo.y(t) - 4}>
                {usd0.format(t)}
              </text>
            </g>
          ))}
          <path className="perf-invested" d={geo.investedPath} />
          <path className="perf-value" d={geo.valuePath} />
          {active !== null && (
            <g>
              <line className="perf-cross" x1={geo.x(idx)} x2={geo.x(idx)} y1={PAD.top} y2={H - PAD.bottom} />
              <circle className="perf-dot-invested" cx={geo.x(idx)} cy={geo.y(p.invested)} r={4} />
              <circle className="perf-dot" cx={geo.x(idx)} cy={geo.y(p.value)} r={5} />
            </g>
          )}
          <text className="perf-axis" x={PAD.left} y={H - 6}>
            {fmtDate(first.date, longDates)}
          </text>
          <text className="perf-axis" x={width - PAD.right} y={H - 6} textAnchor="end">
            {fmtDate(last.date, longDates)}
          </text>
        </svg>
      </div>
      <details className="details">
        <summary>Show as table</summary>
        <table className="perf-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Value</th>
              <th scope="col">Invested</th>
              <th scope="col">Gain</th>
            </tr>
          </thead>
          <tbody>
            {tableRows(points).map((r) => (
              <tr key={r.date}>
                <td>{fmtDate(r.date, true)}</td>
                <td>{money(r.value)}</td>
                <td>{money(r.invested)}</td>
                <td>{signed(r.value - r.invested)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** Up to ~12 evenly spaced rows, newest first. */
function tableRows(points: DayValue[]): DayValue[] {
  const n = Math.min(12, points.length);
  const out: DayValue[] = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round(((points.length - 1) * i) / Math.max(1, n - 1))]!);
  return [...new Map(out.map((r) => [r.date, r])).values()].reverse();
}

/** Small trend line for portfolio cards (decorative; the card states the numbers). */
export function Sparkline({ series }: { series: DayValue[] }) {
  if (series.length < 2) return null;
  const w = 88;
  const h = 28;
  const vals = series.map((s) => s.value);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 0.01) {
    hi += 1;
    lo -= 1;
  }
  const d = series.map((s, i) => `${i ? 'L' : 'M'}${((i / (series.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 3 - ((s.value - lo) / (hi - lo)) * (h - 6)).toFixed(1)}`).join('');
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
