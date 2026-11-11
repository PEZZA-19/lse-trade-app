import { formatMinutes, formatPence, marginBp } from '@lse/shared';
import { Link } from 'react-router';
import { useMe } from '../../api/hooks';
import { useJobCosting } from '../../api/team';
import { KeyValueRow, List, Section } from '../../components/ui';

const signed = (p: number) => `${p < 0 ? '−' : ''}${formatPence(Math.abs(p))}`;

/**
 * Owner only: what was quoted against what the job has really used, and the true profit
 * (revenue − labour at each person's cost rate − materials at cost). Updates as time and
 * materials are added.
 */
export function QuoteVsActual({ jobId }: { jobId: string }) {
  const me = useMe();
  const owner = me.data?.role === 'owner';
  const c = useJobCosting(jobId, owner);
  if (!owner || !c.data) return null;
  const { profit: p, quoted: q, labour } = c.data;
  const bp = marginBp(p);
  return (
    <Section
      header="Quote vs Actual"
      footer={`Labour is costed at each person’s cost rate (Settings › Team); charge-out is the same time at your labour rate. Materials are what you paid. Only you see this.`}
    >
      {!c.data.allRatesSet && (
        <p className="readiness" role="note">
          Someone here has no cost rate, so their time is costed at the charge-out rate.{' '}
          <Link to="/settings">Set it in Settings › Team</Link>
        </p>
      )}
      <List className="form-list" label="Quote vs actual">
        <KeyValueRow
          label={
            p.quotedPence === null ? 'Revenue (job lines, not quoted)' : 'Revenue (quote, ex VAT)'
          }
          value={formatPence(p.revenuePence)}
          strong
        />
        <KeyValueRow
          label={`Labour quoted · ${formatMinutes(q.labourMinutes)}`}
          value={formatPence(q.labourPence)}
        />
        <KeyValueRow
          label={`Labour actual · ${formatMinutes(p.minutes)} at charge-out`}
          value={formatPence(p.chargeOutPence)}
        />
        {labour.map((l) => (
          <KeyValueRow
            key={l.userId}
            label={
              <span className="costing-person">
                {l.name} · {formatMinutes(l.minutes)} × {formatPence(l.ratePence)}/h
                {l.rateIsDefault ? ' (charge-out, no cost rate)' : ' cost'}
              </span>
            }
            value={formatPence(l.costPence)}
          />
        ))}
        <KeyValueRow label="Labour at cost" value={formatPence(p.labourPence)} />
        <KeyValueRow label="Materials quoted (sell)" value={formatPence(q.materialsPence)} />
        <KeyValueRow label="Materials actual (cost)" value={formatPence(p.materialsCostPence)} />
        <KeyValueRow
          label={`Profit${bp !== null ? ` · ${Math.round(bp / 100)}%` : ''}`}
          value={
            <span style={{ color: p.profitPence < 0 ? 'var(--red)' : 'var(--green)' }}>
              {signed(p.profitPence)}
            </span>
          }
          strong
        />
        {p.invoicedPence > 0 && (
          <KeyValueRow label="Invoiced so far (ex VAT)" value={formatPence(p.invoicedPence)} />
        )}
      </List>
    </Section>
  );
}
