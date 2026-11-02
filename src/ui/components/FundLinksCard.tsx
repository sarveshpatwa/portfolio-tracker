import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { linkPriceService } from '../../application/linkPriceService';
import { assetRepo, priceRepo } from '../../data/repositories/assetRepo';
import { portfolioRepo } from '../../data/repositories/portfolioRepo';
import { settingsRepo } from '../../data/repositories/settingsRepo';
import { S } from '../../data/db/schema';
import { groupFunds, type FundGroup } from '../../domain/pricing/fundGroups';
import { parsePriceLink, type PriceLink } from '../../domain/pricing/priceLink';
import { formatUsd } from '../../domain/money/format';
import { formatTradingDate } from './priceLabels';

async function loadFunds() {
  const [instruments, links, portfolios, prices, settings] = await Promise.all([
    assetRepo.listInstruments(),
    assetRepo.listAllLinks(),
    portfolioRepo.list(),
    priceRepo.listAll(),
    settingsRepo.links(),
  ]);
  return { groups: groupFunds(instruments, links, portfolios, prices), relaySet: !!settings.relayUrl };
}

const initialText = (g: FundGroup) => (g.fundId && g.fundId !== 'mixed' ? g.fundId : '');

/**
 * Settings → "Your funds": one-time setup of price links for every manual
 * asset, across all portfolios. The same fund in several portfolios is one row.
 */
export function FundLinksCard() {
  const data = useLiveQuery(loadFunds, [S.instruments, S.portfolioAssets, S.portfolios, S.prices, S.settings]);
  useSyncExternalStore(linkPriceService.subscribe, linkPriceService.getVersion, linkPriceService.getVersion);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = data.status === 'ready' ? data.data.groups : [];
  useEffect(() => {
    // Fill in rows that appeared; keep anything already typed.
    setTexts((t) => {
      const next = { ...t };
      for (const g of groups) if (!(g.key in next)) next[g.key] = initialText(g);
      return next;
    });
  }, [groups.map((g) => `${g.key}:${g.fundId ?? ''}`).join('|')]);

  if (data.status !== 'ready') return null;
  const { relaySet } = data.data;
  const dirty = groups.filter((g) => (texts[g.key] ?? '').trim().toUpperCase() !== initialText(g).toUpperCase() || g.fundId === 'mixed');

  const saveAll = async () => {
    setNote(null);
    const errs: Record<string, string> = {};
    const plan: { group: FundGroup; link: PriceLink | undefined }[] = [];
    for (const g of dirty) {
      const text = (texts[g.key] ?? '').trim();
      if (!text) {
        plan.push({ group: g, link: undefined });
        continue;
      }
      const r = parsePriceLink(text);
      if (!r.ok) errs[g.key] = r.error;
      // Keep the page address when only the code was typed but a link was saved before.
      else plan.push({ group: g, link: r.link.url ? r.link : { url: g.fundId === r.link.fundId ? g.url : '', fundId: r.link.fundId } });
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      for (const { group, link } of plan) await assetRepo.setPriceLink(group.instrumentIds, link);
      setTexts((t) => {
        const next = { ...t };
        for (const { group, link } of plan) next[group.key] = link?.fundId ?? '';
        return next;
      });
      const ids = plan.filter((p) => p.link).flatMap((p) => p.group.instrumentIds);
      setNote(plan.length ? `Saved ${plan.length === 1 ? '1 fund' : `${plan.length} funds`}.` : 'Nothing changed.');
      if (ids.length) await linkPriceService.runDue({ force: true, only: ids });
      else void linkPriceService.runDue();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Saving failed.');
    } finally {
      setBusy(false);
    }
  };

  const linkedCount = groups.filter((g) => g.fundId && g.fundId !== 'mixed').length;

  return (
    <section className="card stack" aria-labelledby="funds-title">
      <h2 id="funds-title" className="section-title">
        Your funds · daily Vanguard prices
      </h2>
      <p className="small">
        Enter each Vanguard fund’s code <b>once</b> (e.g. <code>0066</code> or <code>N467</code>, or paste its page link). From then on the
        closing price is fetched automatically every trading day — when the app opens and while it’s open. The same fund in several
        portfolios is one row. Leave a row empty for assets you price yourself.
      </p>
      {groups.length === 0 ? (
        <p className="muted small">No manual-price assets yet. Add one from a portfolio → Add asset → Manual price.</p>
      ) : (
        <ul className="fund-list">
          {groups.map((g) => {
            const id = g.instrumentIds[0]!;
            const st = linkPriceService.stateOf(id);
            const fetching = g.instrumentIds.some((i) => linkPriceService.stateOf(i).fetching);
            return (
              <li key={g.key} className="stack-tight fund-row">
                <div className="row-between baseline wrap">
                  <span className="strong">{g.name}</span>
                  <span className="muted small">{g.portfolioNames.join(', ')}</span>
                </div>
                <input
                  className="input"
                  aria-label={`${g.name} fund code`}
                  aria-invalid={errors[g.key] ? true : undefined}
                  aria-describedby={`fund-status-${g.key}`}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="e.g. N467 — empty = you type prices"
                  value={texts[g.key] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTexts((t) => ({ ...t, [g.key]: v }));
                    setErrors((er) => ({ ...er, [g.key]: '' }));
                  }}
                />
                <span id={`fund-status-${g.key}`} className="small">
                  {errors[g.key] ? (
                    <span className="field-error">{errors[g.key]}</span>
                  ) : fetching ? (
                    <span className="muted">Fetching…</span>
                  ) : g.fundId === 'mixed' ? (
                    <span className="warn-text">Portfolios have different codes for this fund — save one code to use everywhere.</span>
                  ) : g.fundId && st.error ? (
                    <span className="warn-text">Couldn’t fetch: {st.error}</span>
                  ) : (
                    <span className="muted">
                      {g.latest
                        ? `${formatUsd(g.latest.price, 4)} · ${formatTradingDate(g.latest.date)} · ${g.latest.source === 'link' ? 'from Vanguard' : 'typed'}`
                        : 'No price yet'}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {groups.length > 0 && (
        <div className="row-start wrap">
          <button type="button" className="btn btn-primary" disabled={busy || dirty.length === 0} onClick={() => void saveAll()}>
            {busy ? 'Saving…' : 'Save codes'}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            disabled={busy || !relaySet || linkedCount === 0}
            onClick={() => void linkPriceService.runDue({ force: true })}
          >
            Fetch all now
          </button>
        </div>
      )}
      {!relaySet && groups.length > 0 && <p className="warn-text small">Set up the relay above first — codes can be saved now and fetch once it works.</p>}
      {note && (
        <p className="small" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
