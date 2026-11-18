import { formatPence, type JobDetailDto } from '@lse/shared';
import { useJobCreditChoice, useSession } from '../../api/hooks';
import { useToast } from '../../components/Toast';
import { List, Section } from '../../components/ui';

/**
 * The customer's credit on account and the owner's choice to use it when this job is invoiced
 * (Joe, 18 Nov 2026). Once an invoice is issued the choice moves to the invoice
 * (Use Customer Credit), so here it just says so.
 */
export function CreditSection({ job }: { job: JobDetailDto }) {
  const isOwner = useSession().data?.role === 'owner';
  const choice = useJobCreditChoice(job.id);
  const toast = useToast();
  if (job.customerCreditPence <= 0) return null;
  const credit = formatPence(job.customerCreditPence);
  return (
    <Section
      header="Customer credit"
      footer={
        job.invoiced
          ? `${job.customerName} has ${credit} credit on account. This job has been invoiced: to use it, open the invoice and tap Use Customer Credit.`
          : job.useCredit
            ? `Their credit comes off the invoice for this job; you’ll confirm when you approve it.`
            : `${job.customerName} has ${credit} credit on account. It isn’t used${isOwner ? '; switch on to use it on the invoice for this job' : ''}.`
      }
    >
      {isOwner && !job.invoiced && (
        <List>
          <li>
            <label className="row" style={{ cursor: 'pointer' }}>
              <span className="row__main">
                <span className="row__title">Use their credit</span>
                <span className="row__sub">{credit} on account</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                aria-label="Use their credit when this job is invoiced"
                checked={job.useCredit === true}
                disabled={choice.isPending}
                onChange={(e) =>
                  choice.mutate(e.target.checked, {
                    onSuccess: (r) =>
                      toast.show(
                        r.useCredit
                          ? 'Their credit will be used on the invoice for this job'
                          : 'Their credit stays on their account',
                      ),
                    onError: (err) => toast.show(err.message, { tone: 'error' }),
                  })
                }
              />
            </label>
          </li>
        </List>
      )}
    </Section>
  );
}
