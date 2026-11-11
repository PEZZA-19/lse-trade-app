import { IconCustomers, IconSettings } from '../components/icons';
import { useSync } from '../offline';
import { LinkRow, List, Page, Section } from '../components/ui';

/** The fifth tab: everything that doesn't need its own tab (Apple: at most five tabs). */
export function MoreScreen() {
  const sync = useSync();
  return (
    <Page title="More">
      <Section>
        <List label="More">
          <li>
            <LinkRow
              to="/customers"
              lead={<IconCustomers width={24} height={24} color="var(--accent)" />}
              title="Customers"
            />
          </li>
          <li>
            <LinkRow
              to="/settings"
              lead={<IconSettings width={24} height={24} color="var(--accent)" />}
              title="Settings"
              sub="Business details, numbering, job stages, account"
            />
          </li>
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
