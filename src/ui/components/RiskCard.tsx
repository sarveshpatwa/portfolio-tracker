import { MIN_RISK_DAYS, type RiskLevel, type RiskProfile } from '../../domain/signals/risk';

const POINT_WORD = ['low', 'medium', 'high'] as const;

function LevelBadge({ level }: { level: RiskLevel }) {
  const cls = level === 'Low' ? 'badge-info' : level === 'Medium' ? 'badge-neutral' : 'badge-warn';
  return <span className={`badge ${cls}`}>{level} risk</span>;
}

/** Per-portfolio risk profile: volatility, largest drop, concentration → Low/Medium/High. */
export function RiskCard({ risk }: { risk: RiskProfile }) {
  return (
    <section className="card stack" aria-labelledby="risk-title">
      <div className="row-start">
        <h2 id="risk-title" className="section-title">
          Risk profile
        </h2>
        {risk.level && <LevelBadge level={risk.level} />}
      </div>
      {!risk.level ? (
        <p className="muted small">Shown once the portfolio holds something.</p>
      ) : (
        <>
          <dl className="risk-list">
            {risk.measures.map((m) => (
              <div key={m.key} className="risk-row">
                <dt>
                  <span className="strong">{m.label}</span>
                  {m.points !== null && <span className="muted small"> · {POINT_WORD[m.points]}</span>}
                </dt>
                <dd className="strong">{m.display}</dd>
                <p className="muted small risk-explain">{m.explain}</p>
              </div>
            ))}
          </dl>
          {risk.limitedHistory && (
            <p className="small warn-text">
              Based on concentration only until there are {MIN_RISK_DAYS} days of history ({risk.historyDays} so far).
            </p>
          )}
          {risk.sparseWeight >= 0.3 && (
            <p className="small muted">
              {Math.round(risk.sparseWeight * 100)}% of this portfolio is priced by hand every week or two, so its moves land all at once
              on the days you update — volatility and drops can look smaller or larger than they really are.
            </p>
          )}
          <details className="details small">
            <summary>How is this scored?</summary>
            <p>
              Each measure scores low (0), medium (1) or high (2); the average decides the profile — under 0.67 is Low, under 1.34 is
              Medium, otherwise High.
            </p>
            <ul className="assumptions">
              <li>Volatility: under 10% a year low · 10–18% medium · over 18% high (last year of daily values).</li>
              <li>Largest drop: under 10% low · 10–25% medium · over 25% high (whole history).</li>
              <li>Concentration: largest holding (cash counts as one) under 25% low · 25–50% medium · over 50% high.</li>
            </ul>
            <p>Money you added or withdrew is taken out of volatility and drops, so a contribution never looks like a jump.</p>
          </details>
        </>
      )}
    </section>
  );
}
