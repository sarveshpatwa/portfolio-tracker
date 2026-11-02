import { useEffect, useState, type FormEvent } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { linkPriceService } from '../../application/linkPriceService';
import { settingsRepo } from '../../data/repositories/settingsRepo';
import { S } from '../../data/db/schema';
import { checkFeedTemplate, DEFAULT_FEED_TEMPLATE, parsePriceLink } from '../../domain/pricing/priceLink';
import { formatUsd } from '../../domain/money/format';
import { Field } from './Field';
import { formatTradingDate } from './priceLabels';

/** Settings → Price links: relay address, test, Vanguard data address. */
export function PriceLinkSettingsCard() {
  const settings = useLiveQuery(() => settingsRepo.links(), [S.settings]);
  const [relay, setRelay] = useState('');
  const [template, setTemplate] = useState('');
  const [fund, setFund] = useState('0066');
  const [errors, setErrors] = useState<{ relay?: string; template?: string; fund?: string }>({});
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings.status === 'ready') {
      setRelay(settings.data.relayUrl);
      setTemplate(settings.data.feedTemplate);
    }
  }, [settings.status]);

  if (settings.status !== 'ready') return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setNote(null);
    const next: typeof errors = {};
    const r = relay.trim();
    if (r) {
      try {
        const u = new URL(r);
        const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
        if (u.protocol !== 'https:' && !local) next.relay = 'The relay address must start with https://';
      } catch {
        next.relay = 'That isn’t a web address. Copy it from your Cloudflare Worker page.';
      }
    }
    const tErr = checkFeedTemplate(template);
    if (tErr) next.template = tErr;
    const f = parsePriceLink(fund);
    if (r && !f.ok) next.fund = 'Enter a fund number or code (e.g. 0066 or N467), or a fund page link, to test with.';
    setErrors(next);
    if (Object.keys(next).length) return;

    if (!r) {
      await settingsRepo.setRelayUrl('');
      await settingsRepo.setFeedTemplate(template);
      setNote({ ok: true, text: 'Relay removed. Price links won’t fetch on this device.' });
      void linkPriceService.runDue();
      return;
    }
    setBusy(true);
    try {
      const price = await linkPriceService.test(r, template, f.ok ? f.link.fundId : '');
      await settingsRepo.setRelayUrl(r);
      await settingsRepo.setFeedTemplate(template);
      setNote({ ok: true, text: `Relay works — fund ${f.ok ? f.link.fundId : ''} is ${formatUsd(price.price, 4)} (${formatTradingDate(price.date)}). Saved.` });
      void linkPriceService.runDue({ force: true });
    } catch (err) {
      setNote({ ok: false, text: `${err instanceof Error ? err.message : 'Test failed.'} Not saved.` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="links-title">
      <h2 id="links-title" className="section-title">
        Price links · Vanguard funds
      </h2>
      <p className="small">
        Fetches daily prices for Vanguard funds without a ticker, through your own free Cloudflare relay (setup steps are in the
        README, “Price links”). Set it up once on each device.
      </p>
      <form className="stack" onSubmit={save} noValidate>
        <Field label="Relay address" error={errors.relay} hint="e.g. https://vanguard-relay.yourname.workers.dev — stored on this device only.">
          {(p) => (
            <input
              {...p}
              className="input"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={relay}
              placeholder="https://…workers.dev"
              onChange={(e) => setRelay(e.target.value)}
            />
          )}
        </Field>
        <Field label="Test with fund number or code" error={errors.fund}>
          {(p) => <input {...p} className="input" autoCapitalize="characters" autoComplete="off" value={fund} onChange={(e) => setFund(e.target.value)} />}
        </Field>
        <details className="details">
          <summary>Advanced</summary>
          <Field
            label="Vanguard data address"
            error={errors.template}
            hint={`{id} is replaced by the fund number. Leave empty for the default: ${DEFAULT_FEED_TEMPLATE}`}
          >
            {(p) => (
              <input
                {...p}
                className="input"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={template}
                placeholder={DEFAULT_FEED_TEMPLATE}
                onChange={(e) => setTemplate(e.target.value)}
              />
            )}
          </Field>
        </details>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Testing…' : 'Save and test'}
        </button>
        {note && (
          <p className={`notice-inline ${note.ok ? 'notice-ok' : 'notice-err'}`} role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
      </form>
    </section>
  );
}
