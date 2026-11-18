import { canSee, formatPence } from '@lse/shared';
import { useInvoices } from '../api/billing';
import {
  IconCalendar,
  IconBox,
  IconCustomers,
  IconInvoice,
  IconReceipt,
  IconSettings,
  IconTag,
  IconTruck,
  IconTray,
  IconSeal,
  IconChart,
  IconBusiness,
} from '../components/icons';
import { useAccess } from '../api/hooks';
import { useBills } from '../api/bills';
import { useEnquiryCounts, useProposalCounts } from '../api/inbox';
import { useSync } from '../offline';
import { LinkRow, List, Page, Section } from '../components/ui';

const icon = (I: typeof IconInvoice) => <I width={24} height={24} color="var(--accent)" />;

/** The fifth tab: everything that doesn't need its own tab (Apple: at most five tabs). */
export function MoreScreen() {
  const sync = useSync();
  const access = useAccess();
  const money = canSee(access, 'financials');
  const pricing = canSee(access, 'quotes');
  const unpaid = useInvoices('outstanding', money);
  const items = unpaid.data ?? [];
  const overdue = items.filter((i) => i.displayStatus === 'overdue').length;
  const owed = items.reduce((a, i) => a + i.balancePence, 0);
  const toCheck = useBills('draft', undefined, money).data?.length ?? 0;
  const pending = useProposalCounts().data?.pending ?? 0;
  const todo = useEnquiryCounts().data?.todo ?? 0;
  return (
    <Page title="More">
      <Section header="Inbox">
        <List label="Inbox">
          <li>
            <LinkRow
              to="/approvals"
              lead={icon(IconSeal)}
              title="Approvals"
              sub={pending ? `${pending} waiting for you` : 'Nothing waiting'}
            />
          </li>
          <li>
            <LinkRow
              to="/enquiries"
              lead={icon(IconTray)}
              title="Enquiries"
              sub={todo ? `${todo} to do` : 'All caught up'}
            />
          </li>
        </List>
      </Section>
      {(money || canSee(access, 'reports')) && (
        <Section header="Money">
          <List label="Money">
            {money && canSee(access, 'reports') && (
              <li>
                <LinkRow
                  to="/business"
                  lead={icon(IconBusiness)}
                  title="Business Overview"
                  sub="Bank, owed, cash flow, profit and Xero-style reports"
                />
              </li>
            )}
            {money && (
              <>
                <li>
                  <LinkRow
                    to="/invoices"
                    lead={icon(IconInvoice)}
                    title="Invoices"
                    sub={
                      items.length
                        ? `${items.length} unpaid · ${formatPence(owed)}${overdue ? ` · ${overdue} overdue` : ''}`
                        : 'Nothing waiting to be paid'
                    }
                  />
                </li>
                <li>
                  <LinkRow
                    to="/bills"
                    lead={icon(IconReceipt)}
                    title="Supplier Bills"
                    sub={
                      toCheck
                        ? `${toCheck} to check and apply`
                        : 'Bills and credit notes from your suppliers'
                    }
                  />
                </li>
              </>
            )}
            {canSee(access, 'reports') && (
              <li>
                <LinkRow
                  to="/reports"
                  lead={icon(IconChart)}
                  title="Reports"
                  sub="Money in and owed, profit per job, time"
                />
              </li>
            )}
          </List>
        </Section>
      )}
      {(pricing || money) && (
        <Section header="Pricing">
          <List label="Pricing">
            {pricing && (
              <>
                <li>
                  <LinkRow
                    to="/price-list"
                    lead={icon(IconTag)}
                    title="Price List"
                    sub="Materials, suppliers, cost and markup"
                  />
                </li>
                <li>
                  <LinkRow
                    to="/kits"
                    lead={icon(IconBox)}
                    title="Kits"
                    sub="Sets of items to add to a quote in one go"
                  />
                </li>
              </>
            )}
            {money && (
              <li>
                <LinkRow
                  to="/suppliers"
                  lead={icon(IconTruck)}
                  title="Suppliers"
                  sub="Merchants, their bills and spend"
                />
              </li>
            )}
          </List>
        </Section>
      )}
      <Section>
        <List label="More">
          <li>
            <LinkRow to="/customers" lead={icon(IconCustomers)} title="Customers" />
          </li>
          <li>
            <LinkRow
              to="/calendar"
              lead={icon(IconCalendar)}
              title="Calendar"
              sub="Your jobs in Google Calendar or Outlook"
            />
          </li>
          {canSee(access, 'settings') && (
            <li>
              <LinkRow
                to="/settings"
                lead={icon(IconSettings)}
                title="Settings"
                sub="Business details, numbering, job stages, account"
              />
            </li>
          )}
          <li>
            <LinkRow
              to="/sync"
              lead={
                <span className="row__lead" aria-hidden>
                  ⇅
                </span>
              }
              title="Sync"
              sub={
                sync.ops.length
                  ? `${sync.ops.length} change${sync.ops.length === 1 ? '' : 's'} not on the server yet`
                  : 'Everything is synced'
              }
            />
          </li>
        </List>
      </Section>
    </Page>
  );
}
