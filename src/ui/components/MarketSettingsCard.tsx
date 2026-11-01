import { useEffect, useState, type FormEvent } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { usePriceStatus } from '../../application/usePriceStatus';
import { priceService } from '../../application/priceService';
import { REFRESH_CHOICES, settingsRepo } from '../../data/repositories/settingsRepo';
import { S } from '../../data/db/schema';
import { formatUsd } from '../../domain/money/format';
import { Field } from './Field';

/** Settings → Market data: API key, test, refresh interval, credit usage. */
export function MarketSettingsCard() {
  const settings = useLiveQuery(() => settingsRepo.market(), [S.settings]);
  const status = usePriceStatus();
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [show, setShow] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings.status === 'ready') {
      setKey(settings.data.apiKey);
      setBaseUrl(settings.data.baseUrl);
    }
    // Load once when settings first arrive.
  }, [settings.status]);

  if (settings.status !== 'ready') return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setNote(null);
    const trimmed = key.trim();
    if (!trimmed) {
      await settingsRepo.setApiKey('');
      setNote({ ok: true, text: 'Key removed. Live prices are off.' });
      void priceService.tick();
      return;
    }
    setBusy(true);
    try {
      const q = await priceService.testKey(trimmed, baseUrl.trim());
      await settingsRepo.setApiKey(trimmed);
      await settingsRepo.setBaseUrl(baseUrl);
      setNote({ ok: true, text: `Key works — SPY is ${formatUsd(q.price)}. Prices will refresh automatically.` });
      void priceService.tick();
    } catch (err) {
      setNote({ ok: false, text: `${err instanceof Error ? err.message : 'Test failed.'} The key was not saved.` });
    } finally {
      setBusy(false);
    }
  };

  const pct = Math.min(100, (status.creditsToday / status.creditLimit) * 100);

  return (
    <section className="card stack" aria-labelledby="market-title">
      <h2 id="market-title" className="section-title">
        Market data · Twelve Data
      </h2>
      <p className="small">
        Live prices for US-listed stocks and ETFs. Get a free API key at{' '}
        <a href="https://twelvedata.com/pricing" target="_blank" rel="noreferrer">
          twelvedata.com
        </a>{' '}
        (Basic plan, no card needed), then paste it here.
      </p>

      <form className="stack" onSubmit={save} noValidate>
        <Field label="API key" hint="Stored only on this device and sent only to Twelve Data. Not included in backups.">
          {(p) => (
            <div className="row-start search-row">
              <input
                {...p}
                className="input grow"
                type={show ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setNote(null);
                }}
              />
              <button type="button" className="btn btn-ghost" onClick={() => setShow((v) => !v)} aria-pressed={show}>
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          )}
        </Field>
        <details className="details">
          <summary>Advanced</summary>
          <Field label="API address" hint="Leave empty for Twelve Data. Only change this if you run your own proxy.">
            {(p) => <input {...p} className="input" placeholder="https://api.twelvedata.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />}
          </Field>
        </details>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Testing…' : 'Save and test (1 credit)'}
        </button>
        {note && (
          <p className={`notice-inline ${note.ok ? 'notice-ok' : 'notice-err'}`} role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
      </form>

      <Field label="Refresh prices during US market hours">
        {(p) => (
          <select
            {...p}
            className="input"
            value={settings.data.refreshMinutes}
            onChange={(e) => void settingsRepo.setRefreshMinutes(Number(e.target.value)).then(() => priceService.tick())}
          >
            {REFRESH_CHOICES.map((m) => (
              <option key={m} value={m}>
                Every {m} minutes
              </option>
            ))}
          </select>
        )}
      </Field>
      <p className="muted small">
        US market hours are 9:30 am–4:00 pm New York time: 8:00 pm–2:30 am in India from early November to mid-March, and
        7:00 pm–1:30 am the rest of the year. Prices update only while the app is open.
        {status.intervalLimited &&
          ` With ${status.symbols} tickers, refreshes are spaced every ${status.intervalMinutes} minutes to stay within the free 800 credits a day.`}
      </p>

      <div className="stack-tight">
        <div className="row-between small">
          <span>Credits used today</span>
          <span className="strong">
            {status.creditsToday} of {status.creditLimit}
          </span>
        </div>
        <div className="meter" role="progressbar" aria-label="Credits used today" aria-valuemin={0} aria-valuemax={status.creditLimit} aria-valuenow={status.creditsToday}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small">Counted on this device; resets at midnight UTC (5:30 am India time).</span>
      </div>
    </section>
  );
}
