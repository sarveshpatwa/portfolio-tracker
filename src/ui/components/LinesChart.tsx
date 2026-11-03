import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { parseIso, type IsoDate } from '../../domain/calendar/dates';

/*
 * Several lines on one axis (Compare: one line per portfolio; switch check:
 * old vs new). Hand-drawn SVG. Identity is never colour alone: every line is
 * named in the legend/readout, and the readout lists values at the chosen day.
 * Colours: the validated categorical palette, assigned in fixed order.
 */

export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

export interface Line {
  key: string;
  name: string;
  color: string;
  dashed?: boolean;
  points: { date: IsoDate; value: number }[];
}

const H = 200;
const PAD = { top: 10, right: 8, bottom: 22, left: 8 };
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dLong = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmt = (d: IsoDate) => dLong.format(parseIso(d));

export function LinesChart({ lines, label }: { lines: Line[]; label: string }) {
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

  // Common date axis; each line carries its last value forward over dates it lacks.
  const geo = useMemo(() => {
    const dates = [...new Set(lines.flatMap((l) => l.points.map((p) => p.date)))].sort();
    const values = lines.map((l) => {
      const map = new Map(l.points.map((p) => [p.date, p.value]));
      let last: number | null = null;
      return dates.map((d) => {
        const v = map.get(d);
        if (v !== undefined) last = v;
        return last;
      });
    });
    const all = values.flat().filter((v): v is number => v !== null);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1) {
      hi += 1;
      lo -= 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const innerW = width - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const n = dates.length;
    const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH;
    const paths = values.map((vals) => {
      let d = '';
      vals.forEach((v, i) => {
        if (v === null) return;
        d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      });
      return d;
    });
    const ticks = [lo + (hi - lo) * 0.15, lo + (hi - lo) * 0.5, lo + (hi - lo) * 0.85];
    return { dates, values, paths, x, y, ticks, innerW };
  }, [lines, width]);

  useEffect(() => setActive(null), [lines]);
  if (geo.dates.length === 0) return null;

  const pick = (clientX: number) => {
    const el = box.current;
    if (!el) return;
    const rel = (clientX - el.getBoundingClientRect().left - PAD.left) / geo.innerW;
    setActive(Math.max(0, Math.min(geo.dates.length - 1, Math.round(rel * (geo.dates.length - 1)))));
  };
  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (e.type === 'pointerdown') (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (e.type === 'pointerdown' || e.buttons > 0 || e.pointerType === 'mouse') pick(e.clientX);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = active ?? geo.dates.length - 1;
    if (e.key === 'ArrowLeft') setActive(Math.max(0, cur - 1));
    else if (e.key === 'ArrowRight') setActive(Math.min(geo.dates.length - 1, cur + 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(geo.dates.length - 1);
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };
  const idx = active ?? geo.dates.length - 1;

  return (
    <div className="stack-tight">
      <div className="lines-readout" aria-live="polite">
        <span className="muted small">{fmt(geo.dates[idx]!)}</span>
        {lines.map((l, i) => (
          <span key={l.key} className="nowrap">
            <span className={`legend-swatch ${l.dashed ? 'legend-dashed' : ''}`} style={{ borderTopColor: l.color }} aria-hidden="true" /> {l.name}{' '}
            <b>{geo.values[i]![idx] !== null ? full.format(geo.values[i]![idx]!) : '—'}</b>
          </span>
        ))}
      </div>
      <div ref={box} className="perf-chart">
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          tabIndex={0}
          aria-label={`${label}. Use left and right arrow keys to read each day.`}
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
                {compact.format(t)}
              </text>
            </g>
          ))}
          {lines.map((l, i) => (
            <path key={l.key} d={geo.paths[i]} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeDasharray={l.dashed ? '5 3' : undefined} />
          ))}
          {active !== null && (
            <g>
              <line className="perf-cross" x1={geo.x(idx)} x2={geo.x(idx)} y1={PAD.top} y2={H - PAD.bottom} />
              {lines.map((l, i) =>
                geo.values[i]![idx] !== null ? <circle key={l.key} cx={geo.x(idx)} cy={geo.y(geo.values[i]![idx]!)} r={4.5} fill={l.color} stroke="#fff" strokeWidth={2} /> : null,
              )}
            </g>
          )}
          <text className="perf-axis" x={PAD.left} y={H - 6}>
            {fmt(geo.dates[0]!)}
          </text>
          <text className="perf-axis" x={width - PAD.right} y={H - 6} textAnchor="end">
            {fmt(geo.dates[geo.dates.length - 1]!)}
          </text>
        </svg>
      </div>
    </div>
  );
}
