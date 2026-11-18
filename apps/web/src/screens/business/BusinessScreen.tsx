import { overview, parsePounds, type OpenItem } from '@lse/shared';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useAccess } from '../../api/hooks';
import { useBusiness, useSetOpening } from '../../api/business';
import { IconBusiness, IconChevronRight } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, EmptyState, List, ListSkeleton, Page, TextField } from '../../components/ui';
import { AgeBar, CashChart, Pipeline } from './Charts';
import { changePct, money, plural, pounds, shortDate } from './format';
import { REPORTS } from './reportsList';

/**
 * The business at a glance (Xero's Business Overview): bank, money owed both ways, cash flow,
 * profit, unpaid invoices and bills, and the job pipeline. For people with Accounts and Reports.
 */
export function BusinessScreen() {
  const access = useAccess();
  const b = useBusiness();
  const o = useMemo(() => (b.data ? overview(b.data) : null), [b.data]);
  const [opening, setOpening] = useState(false);

  if (b.isError)
    return (
      <Page title="Business" back={{ label: 'More', to: '/more' }}>
        <EmptyState
          icon={<IconBusiness />}
          title="Couldn’t load the business overview"
          message={b.error.message}
          action={<Button onClick={() => b.refetch()}>Try again</Button>}
        />
      </Page>
    );
  if (!o || !b.data)
    return (
      <Page title="Business" back={{ label: 'More', to: '/more' }}>
        <ListSkeleton rows={8} />
      </Page>
    );

  const yearPct = changePct(o.profit.year.netProfit, o.profit.lastYear.netProfit);
  return (
    <Page
      title="Business"
      subtitle={`Overview as at ${shortDate(o.today)}`}
      back={{ label: 'More', to: '/more' }}
      wide
    >
      <div className="biz-grid">
        <article className="biz-card biz-card--bank" aria-labelledby="biz-bank">
          <header>
            <h2 id="biz-bank">Bank and Cash</h2>
            <Link to="/business/reports/transactions?account=090" className="biz-card__more">
              Transactions <IconChevronRight width={14} height={14} />
            </Link>
          </header>
          <p className="biz-figure">{money(o.bankPence)}</p>
          <p className="biz-sub">Business bank account, from payments recorded in the app</p>
          {!o.hasOpening ? (
            <div className="biz-callout" role="note">
              <p>Add the bank balance on the day your records start, so this matches your bank.</p>
              {access.isAdmin && (
                <Button variant="secondary" onClick={() => setOpening(true)}>
                  Set Opening Balance
                </Button>
              )}
            </div>
          ) : (
            access.isAdmin && (
              <Button variant="plain" className="biz-link-btn" onClick={() => setOpening(true)}>
                Opening balance {money(b.data.opening!.bankPence)} on{' '}
                {shortDate(b.data.opening!.date)} · Change
              </Button>
            )
          )}
        </article>

        <article className="biz-card" aria-labelledby="biz-owed">
          <header>
            <h2 id="biz-owed">Owed to You</h2>
            <Link to="/business/reports/aged-receivables" className="biz-card__more">
              Aged <IconChevronRight width={14} height={14} />
            </Link>
          </header>
          <p className="biz-figure">{money(o.owedToYou.totalPence)}</p>
          <p className="biz-sub">
            {plural(o.owedToYou.count, 'invoice')} unpaid
            {o.owedToYou.overdueCount > 0 && (
              <>
                {' · '}
                <span className="biz-bad">{money(o.owedToYou.overduePence)} overdue</span>
              </>
            )}
          </p>
          <AgeBar buckets={o.owedToYou.buckets} label="Owed to you by age" />
        </article>

        <article className="biz-card" aria-labelledby="biz-owe">
          <header>
            <h2 id="biz-owe">You Owe</h2>
            <Link to="/business/reports/aged-payables" className="biz-card__more">
              Aged <IconChevronRight width={14} height={14} />
            </Link>
          </header>
          <p className="biz-figure">{money(o.youOwe.totalPence)}</p>
          <p className="biz-sub">
            {plural(o.youOwe.count, 'supplier bill')} unpaid
            {o.youOwe.overdueCount > 0 && (
              <>
                {' · '}
                <span className="biz-bad">{money(o.youOwe.overduePence)} overdue</span>
              </>
            )}
          </p>
          <AgeBar buckets={o.youOwe.buckets} label="You owe by age" />
        </article>

        <article className="biz-card biz-card--wide" aria-labelledby="biz-cash">
          <header>
            <h2 id="biz-cash">Cash In and Out</h2>
            <Link to="/business/reports/cash-flow" className="biz-card__more">
              Cash Flow <IconChevronRight width={14} height={14} />
            </Link>
          </header>
          <CashChart months={o.cash} />
          <dl className="biz-pairs">
            <div>
              <dt>In, last 12 months</dt>
              <dd className="biz-good">{pounds(o.cash.reduce((s, m) => s + m.inPence, 0))}</dd>
            </div>
            <div>
              <dt>Out, last 12 months</dt>
              <dd>{pounds(o.cash.reduce((s, m) => s + m.outPence, 0))}</dd>
            </div>
          </dl>
        </article>

        <article className="biz-card" aria-labelledby="biz-profit">
          <header>
            <h2 id="biz-profit">Profit</h2>
            <Link to="/business/reports/profit-and-loss" className="biz-card__more">
              P&amp;L <IconChevronRight width={14} height={14} />
            </Link>
          </header>
          <p className="biz-figure">{money(o.profit.year.netProfit)}</p>
          <p className="biz-sub">
            Year to date, from {shortDate(o.year.from)}
            {yearPct !== null && (
              <>
                {' · '}
                <span className={yearPct >= 0 ? 'biz-good' : 'biz-bad'}>
                  {yearPct >= 0 ? '▲' : '▼'} {Math.abs(yearPct)}% on last year
                </span>
              </>
            )}
          </p>
          <dl className="biz-rows">
            <div>
              <dt>Income</dt>
              <dd>{money(o.profit.year.income)}</dd>
            </div>
            <div>
              <dt>Cost of sales</dt>
              <dd>{money(-o.profit.year.costOfSales)}</dd>
            </div>
            <div className="biz-rows__total">
              <dt>Gross profit</dt>
              <dd>{money(o.profit.year.grossProfit)}</dd>
            </div>
            <div>
              <dt>This month</dt>
              <dd>{money(o.profit.month.netProfit)}</dd>
            </div>
          </dl>
        </article>

        <article className="biz-card" aria-labelledby="biz-pipeline">
          <header>
            <h2 id="biz-pipeline">Job Pipeline</h2>
            <Link to="/jobs" className="biz-card__more">
              Jobs <IconChevronRight width={14} height={14} />
            </Link>
          </header>
          <Pipeline stages={o.pipeline.filter((s) => s.count > 0 || s.valuePence > 0)} showValue />
          <p className="biz-sub biz-sub--foot">
            {o.openQuotes.count > 0 ? (
              <Link to="/quotes">
                {plural(o.openQuotes.count, 'quote')} waiting for an answer ·{' '}
                {pounds(o.openQuotes.valuePence)}
              </Link>
            ) : (
              'No quotes waiting for an answer'
            )}
          </p>
        </article>

        <article className="biz-card" aria-labelledby="biz-unpaid">
          <header>
            <h2 id="biz-unpaid">Unpaid Invoices</h2>
            <Link to="/invoices" className="biz-card__more">
              All <IconChevronRight width={14} height={14} />
            </Link>
          </header>
          <Items
            items={o.unpaidInvoices}
            to={(i) => `/invoices/${i.id}`}
            empty="Nothing waiting to be paid."
          />
        </article>

        <article className="biz-card" aria-labelledby="biz-bills">
          <header>
            <h2 id="biz-bills">Bills to Pay</h2>
            <Link to="/bills" className="biz-card__more">
              All <IconChevronRight width={14} height={14} />
            </Link>
          </header>
          <Items
            items={o.unpaidBills}
            to={(i) => `/bills/${i.id}`}
            empty="No supplier bills to pay."
          />
        </article>

        <article className="biz-card biz-card--wide" aria-labelledby="biz-reports">
          <header>
            <h2 id="biz-reports">Reports</h2>
          </header>
          <ul className="biz-reports">
            {REPORTS.map((r) => (
              <li key={r.kind}>
                <Link to={`/business/reports/${r.kind}`}>
                  <span
                    className="biz-reports__icon"
                    style={{ background: r.colour }}
                    aria-hidden="true"
                  >
                    {r.glyph}
                  </span>
                  <span>
                    <b>{r.title}</b>
                    <small>{r.sub}</small>
                  </span>
                  <IconChevronRight width={16} height={16} className="biz-reports__chev" />
                </Link>
              </li>
            ))}
          </ul>
        </article>
      </div>
      <OpeningSheet
        open={opening}
        onClose={() => setOpening(false)}
        current={b.data.opening}
        today={o.today}
      />
    </Page>
  );
}

function Items({
  items,
  to,
  empty,
}: {
  items: OpenItem[];
  to: (i: OpenItem) => string;
  empty: string;
}) {
  if (!items.length) return <p className="biz-empty">{empty}</p>;
  const shown = items.slice(0, 6);
  return (
    <>
      <ul className="biz-items">
        {shown.map((i) => (
          <li key={i.id}>
            <Link to={to(i)}>
              <span className="biz-items__main">
                <b>{i.contact}</b>
                <small>
                  {i.reference}
                  {i.dueDate ? ` · due ${shortDate(i.dueDate)}` : ''}
                </small>
              </span>
              <span className="biz-items__amt">
                {money(i.duePence)}
                {i.daysOverdue > 0 ? (
                  <small className="biz-bad">{plural(i.daysOverdue, 'day')} overdue</small>
                ) : (
                  <small>{i.dueDate ? 'Not due yet' : 'No due date'}</small>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <p className="biz-sub biz-sub--foot">and {items.length - shown.length} more</p>
      )}
    </>
  );
}

function OpeningSheet(props: {
  open: boolean;
  onClose: () => void;
  current: { date: string; bankPence: number } | null;
  today: string;
}) {
  const set = useSetOpening();
  const toast = useToast();
  const [date, setDate] = useState(props.current?.date ?? `${props.today.slice(0, 4)}-01-01`);
  const [amount, setAmount] = useState(
    props.current ? (props.current.bankPence / 100).toFixed(2) : '',
  );
  const neg = amount.trim().startsWith('-') || amount.trim().startsWith('−');
  const pence = parsePounds(amount.replace(/^[-−]/, ''));
  const error = amount && pence === null ? 'Enter an amount, e.g. 2500.00' : undefined;
  const save = () => {
    if (pence === null) return;
    set.mutate(
      { date, bankPence: neg ? -pence : pence },
      {
        onSuccess: () => {
          toast.show('Opening balance saved');
          props.onClose();
        },
        onError: (e) => toast.show(e.message),
      },
    );
  };
  return (
    <Sheet
      open={props.open}
      title="Opening Balance"
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={save}
          disabled={pence === null || !date}
          loading={set.isPending}
        >
          Save
        </Button>
      }
    >
      <List className="form-list" label="Opening balance">
        <TextField
          label="Date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <TextField
          label="Bank balance (£)"
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          error={error}
          onChange={(e) => setAmount(e.target.value)}
        />
      </List>
      <p className="section__footer">
        The balance on your bank statement at the end of that day (put a minus in front if
        overdrawn). Payments recorded in the app from then on move it up and down.
      </p>
    </Sheet>
  );
}
