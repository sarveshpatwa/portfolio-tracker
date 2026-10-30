import { useState, type FormEvent } from 'react';
import { Dec } from '../../domain/money/decimal';
import { todayLocal } from '../../domain/calendar/dates';
import { formatQty, formatUsd } from '../../domain/money/format';
import {
  parseHoldingUpdate,
  type HoldingUpdate,
  type HoldingUpdateErrors,
  type HoldingUpdateInput,
} from '../../domain/assets/holdingUpdate';
import { Field } from './Field';

/**
 * One dialog for everything that changes a manual holding: a new price,
 * more units (paid for, or earned), or a new total from a statement.
 */
export function HoldingUpdateForm({
  unitsHeld,
  currentPrice,
  onSubmit,
  onCancel,
}: {
  unitsHeld: Dec;
  currentPrice?: Dec;
  onSubmit: (update: HoldingUpdate) => Promise<void>;
  onCancel: () => void;
}) {
  const today = todayLocal();
  const [form, setForm] = useState<HoldingUpdateInput>({
    date: today,
    price: currentPrice ? currentPrice.toString() : '',
    unitsMode: 'add',
    units: '',
    source: '',
  });
  const [errors, setErrors] = useState<HoldingUpdateErrors>({});
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof HoldingUpdateInput>(key: K, value: HoldingUpdateInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }));
  };

  // Live preview of what the update will do (ignores invalid input).
  const price = Dec.tryParse(form.price);
  const entered = Dec.tryParse(form.units);
  const change = !entered ? Dec.ZERO : form.unitsMode === 'add' ? entered : entered.sub(unitsHeld);
  const after = unitsHeld.add(change);
  const changeValue = price && price.isPositive() && entered && !after.isNegative() ? change.abs().mul(price) : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = parseHoldingUpdate(form, { unitsHeld, ...(currentPrice ? { currentPrice } : {}), today });
    if (!r.ok) return setErrors(r.errors);
    setBusy(true);
    try {
      await onSubmit(r.value);
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Saving failed.' });
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="grid-2">
        <Field label="Date" error={errors.date}>
          {(p) => <input {...p} className="input" type="date" value={form.date} max={today} onChange={(e) => set('date', e.target.value)} />}
        </Field>
        <Field label="Price per unit ($)" error={errors.price}>
          {(p) => (
            <input {...p} className="input" inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} />
          )}
        </Field>
      </div>
      <p className="muted small">Leave the price as it is if it didn't change (e.g. a stock that stays at $1.00).</p>

      <fieldset className="fieldset">
        <legend className="field-label">Units · now {formatQty(unitsHeld)}</legend>
        <div className="segmented segmented-large" role="group" aria-label="How to enter units">
          <button type="button" aria-pressed={form.unitsMode === 'add'} onClick={() => set('unitsMode', 'add')}>
            Add units
          </button>
          <button type="button" aria-pressed={form.unitsMode === 'total'} onClick={() => set('unitsMode', 'total')}>
            New total
          </button>
        </div>
        <Field
          label={form.unitsMode === 'add' ? 'Units to add' : 'Total units now (from your statement)'}
          error={errors.units}
          hint="Optional — leave empty to update only the price."
        >
          {(p) => (
            <input {...p} className="input" inputMode="decimal" value={form.units} placeholder="0" onChange={(e) => set('units', e.target.value)} />
          )}
        </Field>

        {changeValue && !change.isZero() && (
          <p className="small strong">
            {formatQty(unitsHeld)} → {formatQty(after)} units ({change.isPositive() ? '+' : '−'}
            {formatQty(change.abs())} worth {formatUsd(changeValue)})
          </p>
        )}

        {change.isPositive() && (
          <div className="stack-tight" role="radiogroup" aria-labelledby="source-label" aria-describedby={errors.source ? 'source-error' : undefined}>
            <span id="source-label" className="field-label">
              Where did the new units come from?
            </span>
            <label className={`choice ${form.source === 'earned' ? 'choice-on' : ''}`}>
              <input type="radio" name="source" checked={form.source === 'earned'} onChange={() => set('source', 'earned')} />
              <span>
                <b>Earned or reinvested</b>
                <span className="muted small block">Dividends, interest or bonus units. No new money — counts as gain.</span>
              </span>
            </label>
            <label className={`choice ${form.source === 'money' ? 'choice-on' : ''}`}>
              <input type="radio" name="source" checked={form.source === 'money'} onChange={() => set('source', 'money')} />
              <span>
                <b>Bought with new money</b>
                <span className="muted small block">You paid for them — counts as invested, not as gain.</span>
              </span>
            </label>
            {errors.source && (
              <span id="source-error" className="field-error">
                {errors.source}
              </span>
            )}
          </div>
        )}
        {change.isNegative() && changeValue && (
          <p className="muted small">The removed units are sold at this price and {formatUsd(changeValue)} goes to the portfolio's cash.</p>
        )}
      </fieldset>

      {errors.form && (
        <p className="field-error" role="alert">
          {errors.form}
        </p>
      )}
      <div className="row-end">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}
