import { useState, type FormEvent } from 'react';
import type { HoldingSignals } from '../../application/portfolioQueries';
import { DEFAULT_SIGNAL_SETTINGS, parseSignalSettings, type Severity } from '../../domain/signals/holdingSignals';
import type { SignalSettings } from '../../domain/types';
import { portfolioRepo } from '../../data/repositories/portfolioRepo';
import { Dialog } from './Dialog';
import { Field } from './Field';

/** "⚠ Warning" / "● Watch" — icon + word, never colour alone. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return severity === 'warning' ? (
    <span className="badge badge-warn">
      <span aria-hidden="true">⚠ </span>Warning
    </span>
  ) : (
    <span className="badge badge-neutral">
      <span aria-hidden="true">● </span>Watch
    </span>
  );
}

export function SignalsCard({ portfolioId, signals, settings }: { portfolioId: string; signals: HoldingSignals[]; settings: SignalSettings }) {
  const [editing, setEditing] = useState(false);
  const total = signals.reduce((a, h) => a + h.signals.length, 0);

  return (
    <section className="card stack" aria-labelledby="signals-title">
      <div className="row-between">
        <h2 id="signals-title" className="section-title">
          Signals{' '}
          {signals.length > 0 && (
            <span className="muted normal small">
              · {total}
            </span>
          )}
        </h2>
        <button className="btn btn-small btn-outline" onClick={() => setEditing(true)}>
          Adjust alerts
        </button>
      </div>

      {signals.length === 0 ? (
        <p className="muted small">
          No signals. Checking for: a fall of {settings.declinePct}% in {settings.declineDays} days, {settings.drawdownPct}% below the
          1-year high
          {settings.movingAverageDays > 0 && `, below the ${settings.movingAverageDays}-day average`}, unusual swings, any holding over{' '}
          {settings.concentrationPct}% of the portfolio, and alert prices you set.
        </p>
      ) : (
        <ul className="signal-list">
          {signals.map((h) => (
            <li key={h.instrumentId} className="stack-tight">
              <span className="strong">{h.name}</span>
              <ul className="signal-items">
                {h.signals.map((s) => (
                  <li key={s.kind + s.title}>
                    <div className="row-start wrap">
                      <SeverityBadge severity={s.severity} />
                      <span>{s.title}</span>
                    </div>
                    <p className="muted small">{s.reason}</p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Information only — the app never buys or sells for you.</p>

      <Dialog open={editing} title="Alert thresholds" onClose={() => setEditing(false)}>
        {editing && <ThresholdsForm portfolioId={portfolioId} settings={settings} onDone={() => setEditing(false)} />}
      </Dialog>
    </section>
  );
}

const FIELDS: { key: keyof SignalSettings; label: string; hint: string }[] = [
  { key: 'declinePct', label: 'Fall of (%)', hint: 'Price down at least this much…' },
  { key: 'declineDays', label: '…within (days)', hint: 'Calendar days.' },
  { key: 'drawdownPct', label: 'Below 1-year high by (%)', hint: 'Warning when this far under its highest price of the last year.' },
  { key: 'concentrationPct', label: 'One holding over (%) of the portfolio', hint: 'Warning at twice this (min. 50%). 0 = off.' },
  { key: 'volatilityMultiple', label: 'Swings more than (× usual)', hint: 'Last 20 trading days vs the year before. Daily prices only. 0 = off.' },
  { key: 'movingAverageDays', label: 'Below its average of (days)', hint: 'Daily prices only. 0 = off.' },
];

function ThresholdsForm({ portfolioId, settings, onDone }: { portfolioId: string; settings: SignalSettings; onDone: () => void }) {
  const toText = (s: SignalSettings) => Object.fromEntries(FIELDS.map((f) => [f.key, String(s[f.key])])) as Record<keyof SignalSettings, string>;
  const [form, setForm] = useState(toText(settings));
  const [errors, setErrors] = useState<Partial<Record<keyof SignalSettings, string>>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = parseSignalSettings(form);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setBusy(true);
    const isDefault = FIELDS.every((f) => r.value[f.key] === DEFAULT_SIGNAL_SETTINGS[f.key]);
    await portfolioRepo.setSignalSettings(portfolioId, isDefault ? undefined : r.value);
    onDone();
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p className="muted small">For this portfolio. Synced to your other device through backups.</p>
      {FIELDS.map((f) => (
        <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]}>
          {(p) => (
            <input
              {...p}
              className="input"
              inputMode="decimal"
              value={form[f.key]}
              onChange={(e) => {
                const v = e.target.value;
                setForm((x) => ({ ...x, [f.key]: v }));
                setErrors((x) => ({ ...x, [f.key]: undefined }));
              }}
            />
          )}
        </Field>
      ))}
      <div className="row-between">
        <button type="button" className="btn btn-ghost" onClick={() => setForm(toText(DEFAULT_SIGNAL_SETTINGS))}>
          Reset to defaults
        </button>
        <div className="row-end">
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
        </div>
      </div>
    </form>
  );
}
