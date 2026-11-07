import { useSyncExternalStore } from 'react';
import { useLiveQuery } from '../../application/useLiveQuery';
import { linkPriceService } from '../../application/linkPriceService';
import { assetRepo, priceRepo } from '../../data/repositories/assetRepo';
import { portfolioRepo } from '../../data/repositories/portfolioRepo';
import { settingsRepo } from '../../data/repositories/settingsRepo';
import { S } from '../../data/db/schema';
import { groupFunds } from '../../domain/pricing/fundGroups';
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


/**
 * Settings → "Your funds": status of every manual-price asset (all portfolios).
 * Codes are set in ONE place — when adding the asset, or ··· on the holding —
 * so this list only shows where each fund's price comes from and how fresh it is.
 */
export function FundLinksCard() {
  const data = useLiveQuery(loadFunds, [S.instruments, S.portfolioAssets, S.portfolios, S.prices, S.settings]);
  useSyncExternalStore(linkPriceService.subscribe, linkPriceService.getVersion, linkPriceService.getVersion);
  if (data.status !== 'ready') return null;
  const { groups, relaySet } = data.data;
  const linked = groups.filter((g) => g.fundId && g.fundId !== 'mixed');

  return (
    <section className="card stack" aria-labelledby="funds-title">
      <h2 id="funds-title" className="section-title">
        Your funds · where prices come from
      </h2>
      <p className="muted small">
        To fetch a fund’s daily price from Vanguard, choose it when adding the asset, or use ··· on the holding. The same fund in several
        portfolios gets the code everywhere.
      </p>
      {groups.length === 0 ? (
        <p className="muted small">No manual-price assets yet.</p>
      ) : (
        <ul className="fund-list">
          {groups.map((g) => {
            const st = linkPriceService.stateOf(g.instrumentIds[0]!);
            const fetching = g.instrumentIds.some((i) => linkPriceService.stateOf(i).fetching);
            const coded = g.fundId && g.fundId !== 'mixed';
            return (
              <li key={g.key} className="stack-tight fund-row">
                <div className="row-between baseline wrap">
                  <span className="strong">{g.name}</span>
                  <span className="muted small">{g.portfolioNames.join(', ')}</span>
                </div>
                <span className="small">
                  {coded ? (
                    <span className="badge badge-info">Vanguard {g.fundId}</span>
                  ) : g.fundId === 'mixed' ? (
                    <span className="badge badge-warn">Different codes</span>
                  ) : (
                    <span className="badge badge-neutral">Typed prices</span>
                  )}{' '}
                  {fetching ? (
                    <span className="muted">Fetching…</span>
                  ) : coded && st.error ? (
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
      {linked.length > 0 && (
        <button type="button" className="btn btn-outline" disabled={!relaySet} onClick={() => void linkPriceService.runDue({ force: true })}>
          Fetch all now
        </button>
      )}
      {!relaySet && linked.length > 0 && <p className="warn-text small">Set up the relay above first.</p>}
    </section>
  );
}
