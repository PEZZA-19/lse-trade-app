import type { BusinessDocument } from '@lse/shared';

/**
 * On-screen version of the PDF, drawn from the same layout model so what Joe checks is what the
 * customer gets. Sized in "points" relative to an A4 page width, so it scales to any screen.
 * Paper stays white in dark mode, like a printed page.
 */
export function DocumentView({ doc }: { doc: BusinessDocument }) {
  const b = doc.business;
  return (
    <article className="paper" aria-label={`${doc.title} ${doc.number} preview`}>
      {doc.draftLabel && (
        <div className="paper__watermark" aria-hidden>
          {doc.draftLabel.split(':')[0]}
        </div>
      )}
      <header className="paper__head">
        <div className="paper__from">
          <div className="paper__logo" aria-hidden>
            {b.initials}
          </div>
          <div>
            <div className="paper__biz">{b.name}</div>
            {[...b.addressLines, b.email, b.phone].filter(Boolean).map((l) => (
              <div key={l} className="paper__muted">
                {l}
              </div>
            ))}
            {b.legalName && <div className="paper__muted paper__small">{b.legalName}</div>}
          </div>
        </div>
        <div className="paper__title">
          <div className="paper__kind">{doc.title.toUpperCase()}</div>
          <div className="paper__number">{doc.number}</div>
          {doc.draftLabel && <div className="paper__draft">{doc.draftLabel}</div>}
          <dl className="paper__meta">
            {doc.meta.map((m) => (
              <div key={m.label}>
                <dt>{m.label}</dt>
                <dd>{m.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>
      <div className="paper__parties">
        <div>
          <div className="paper__label">{doc.kind === 'quote' ? 'Prepared for' : 'Bill to'}</div>
          <div className="paper__strong">{doc.billTo.name}</div>
          {doc.billTo.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
        <div>
          <div className="paper__label">{doc.kind === 'quote' ? 'Work' : 'Job'}</div>
          <div className="paper__strong">{doc.jobTitle}</div>
          {doc.siteLines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      </div>
      {doc.sections.map((s) => (
        <section key={s.title} className="paper__section">
          <table>
            <caption>
              {s.title}
              {s.optional && <span className="paper__muted"> not included in the total</span>}
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Description</span>
                </th>
                <th scope="col">{s.qtyLabel}</th>
                <th scope="col">Rate</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    {r.description}
                    {r.detail && <div className="paper__muted paper__small">{r.detail}</div>}
                  </td>
                  <td>{r.qty}</td>
                  <td>{r.rate}</td>
                  <td>{r.amount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>{s.title} total</td>
                <td>{s.total}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      ))}
      <dl className="paper__totals">
        {doc.totals.map((t) => (
          <div key={t.label} className={t.strong ? 'is-strong' : undefined}>
            <dt>{t.label}</dt>
            <dd>{t.value}</dd>
          </div>
        ))}
      </dl>
      {doc.payment && (
        <div className="paper__pay">
          <div className="paper__strong">How to pay</div>
          <dl>
            <div>
              <dt>Account name</dt>
              <dd>{doc.payment.accountName}</dd>
            </div>
            <div>
              <dt>Sort code</dt>
              <dd>{doc.payment.sortCode}</dd>
            </div>
            <div>
              <dt>Account number</dt>
              <dd>{doc.payment.accountNumber}</dd>
            </div>
            <div>
              <dt>Reference</dt>
              <dd className="paper__strong">{doc.payment.reference}</dd>
            </div>
          </dl>
        </div>
      )}
      {doc.notes && (
        <div className="paper__terms">
          <div className="paper__strong">Notes</div>
          <p>{doc.notes}</p>
        </div>
      )}
      {doc.terms && (
        <div className="paper__terms">
          <div className="paper__strong">Terms</div>
          <p>{doc.terms}</p>
        </div>
      )}
    </article>
  );
}
