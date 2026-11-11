import { CONTACT_ROLE_LABELS, formatPence } from '@lse/shared';
import { useState } from 'react';
import { useParams } from 'react-router';
import { useCustomer } from '../api/hooks';
import { IconCustomers, IconMail, IconPhone, IconPlusCircle } from '../components/icons';
import {
  Button,
  ButtonRow,
  EmptyState,
  KeyValueRow,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
  StaticRow,
} from '../components/ui';
import { QUOTE_STATUS } from '../lib/status';
import { StagePill } from '../components/Stage';
import { NewJobSheet } from './sheets/NewJobSheet';
import { NewQuoteSheet } from './sheets/NewQuoteSheet';
import { AddContactSheet, AddSiteSheet } from './sheets/SiteContactSheets';

export function CustomerScreen() {
  const { id = '' } = useParams();
  const customer = useCustomer(id);
  const [sheet, setSheet] = useState<'quote' | 'job' | 'site' | 'contact' | null>(null);
  const close = () => setSheet(null);

  if (customer.isPending)
    return (
      <Page title="" back={{ label: 'Customers', to: '/customers' }}>
        <ListSkeleton rows={3} />
      </Page>
    );
  if (customer.isError)
    return (
      <Page title="Customer" back={{ label: 'Customers', to: '/customers' }}>
        <EmptyState
          icon={<IconCustomers />}
          title="Couldn’t load this customer"
          message={customer.error.message}
          action={<Button onClick={() => customer.refetch()}>Try again</Button>}
        />
      </Page>
    );
  const c = customer.data;
  const siteName = (siteId: string | null) =>
    c.sites.find((s) => s.id === siteId)?.label ?? c.sites.find((s) => s.id === siteId)?.address;

  return (
    <Page title={c.name} back={{ label: 'Customers', to: '/customers' }}>
      <div className="action-bar">
        <Button large block onClick={() => setSheet('quote')}>
          New quote
        </Button>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {c.phone && (
            <a className="btn btn--secondary" style={{ flex: 1 }} href={`tel:${c.phone}`}>
              <IconPhone width={18} height={18} /> Call
            </a>
          )}
          {c.email && (
            <a className="btn btn--secondary" style={{ flex: 1 }} href={`mailto:${c.email}`}>
              <IconMail width={18} height={18} /> Email
            </a>
          )}
          <Button variant="secondary" style={{ flex: 1 }} onClick={() => setSheet('job')}>
            New job
          </Button>
        </div>
      </div>

      <Section header="Details">
        <List>
          <li>
            <KeyValueRow label="Phone" value={c.phone ?? '—'} />
          </li>
          <li>
            <KeyValueRow label="Email" value={c.email ?? '—'} />
          </li>
          <li>
            <KeyValueRow label="Billing address" value={c.billingAddress ?? '—'} />
          </li>
          {c.markupBp && (
            <li>
              <KeyValueRow label="Markup" value={`${c.markupBp / 10000}×`} />
            </li>
          )}
        </List>
      </Section>

      <Section header="Sites">
        <List>
          {c.sites.map((s) => (
            <li key={s.id}>
              <StaticRow>
                <span className="row__main">
                  <span className="row__title">{s.label ?? s.address}</span>
                  {s.label && <span className="row__sub">{s.address}</span>}
                </span>
              </StaticRow>
            </li>
          ))}
          <li>
            <ButtonRow
              onClick={() => setSheet('site')}
              lead={<IconPlusCircle width={22} height={22} color="var(--accent)" />}
              title={<span style={{ color: 'var(--accent)' }}>Add site</span>}
            />
          </li>
        </List>
      </Section>

      <Section header="Contacts">
        <List>
          {c.contacts.map((p) => (
            <li key={p.id}>
              <StaticRow>
                <span className="row__main">
                  <span className="row__title">{p.name}</span>
                  <span className="row__sub">
                    {[p.phone, p.email, p.siteId ? siteName(p.siteId) : null]
                      .filter(Boolean)
                      .join(' · ') || 'No details'}
                  </span>
                </span>
                <span className="row__meta">
                  <Pill tone="grey">{CONTACT_ROLE_LABELS[p.role]}</Pill>
                </span>
              </StaticRow>
            </li>
          ))}
          <li>
            <ButtonRow
              onClick={() => setSheet('contact')}
              lead={<IconPlusCircle width={22} height={22} color="var(--accent)" />}
              title={<span style={{ color: 'var(--accent)' }}>Add contact</span>}
            />
          </li>
        </List>
      </Section>

      {c.quotes.length > 0 && (
        <Section header="Quotes">
          <List>
            {c.quotes.map((q) => (
              <li key={q.id}>
                <LinkRow
                  to={`/quotes/${q.id}`}
                  title={q.title}
                  sub={q.displayNumber}
                  meta={
                    <>
                      <span className="num">{formatPence(q.totalPence)}</span>
                      <Pill tone={QUOTE_STATUS[q.status].tone}>{QUOTE_STATUS[q.status].label}</Pill>
                    </>
                  }
                />
              </li>
            ))}
          </List>
        </Section>
      )}
      {c.jobs.length > 0 && (
        <Section header="Jobs">
          <List>
            {c.jobs.map((j) => (
              <li key={j.id}>
                <LinkRow
                  to={`/jobs/${j.id}`}
                  title={j.title}
                  sub={`Job ${j.number}`}
                  meta={<StagePill stage={j.stage} />}
                />
              </li>
            ))}
          </List>
        </Section>
      )}

      <NewQuoteSheet open={sheet === 'quote'} onClose={close} customerId={c.id} />
      <NewJobSheet open={sheet === 'job'} onClose={close} customerId={c.id} />
      <AddSiteSheet open={sheet === 'site'} onClose={close} customerId={c.id} />
      <AddContactSheet
        open={sheet === 'contact'}
        onClose={close}
        customerId={c.id}
        sites={c.sites}
      />
    </Page>
  );
}
