import { formatPence, type SupplierDto } from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useBills, useSaveSupplier, useSupplier, useSuppliers } from '../../api/bills';
import { ApiError } from '../../api/client';
import { useSession } from '../../api/hooks';
import { IconPlus, IconTruck } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  EmptyState,
  IconButton,
  KeyValueRow,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { shortDate } from '../../lib/status';

/** Net spend; a supplier you've only had credit from reads "£48.00 credit", not a bare minus. */
const spend = (p: number) => (p < 0 ? `${formatPence(-p)} credit` : formatPence(p));

/** Merchants and wholesalers: their bills, spend and price-list items. */
export function SuppliersScreen() {
  const list = useSuppliers();
  const isOwner = useSession().data?.role === 'owner';
  const [adding, setAdding] = useState(false);
  const items = list.data ?? [];
  return (
    <Page
      title="Suppliers"
      back={{ label: 'More', to: '/more' }}
      actions={
        isOwner && (
          <IconButton label="New supplier" onClick={() => setAdding(true)}>
            <IconPlus />
          </IconButton>
        )
      }
    >
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <EmptyState
          icon={<IconTruck />}
          title="Couldn’t load suppliers"
          message={list.error.message}
          action={<Button onClick={() => list.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconTruck />}
          title="No suppliers yet"
          message="Suppliers are added when you enter their first bill, or tap + to add one."
        />
      ) : (
        <Section footer="Spend counts applied bills, less credit notes.">
          <List label="Suppliers">
            {items.map((s) => (
              <li key={s.id}>
                <LinkRow
                  to={`/suppliers/${s.id}`}
                  title={s.name}
                  sub={[
                    `${s.priceItemCount} ${s.priceItemCount === 1 ? 'item' : 'items'} on price list`,
                    s.billCount ? `${s.billCount} ${s.billCount === 1 ? 'bill' : 'bills'}` : null,
                    s.lastBillDate ? `last ${shortDate(`${s.lastBillDate}T12:00:00Z`)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  meta={<span className="num">{spend(s.spendPence)}</span>}
                />
              </li>
            ))}
          </List>
        </Section>
      )}
      {adding && <SupplierSheet onClose={() => setAdding(false)} />}
    </Page>
  );
}

export function SupplierScreen() {
  const { id = '' } = useParams();
  const s = useSupplier(id);
  const bills = useBills('all', id);
  const isOwner = useSession().data?.role === 'owner';
  const [editing, setEditing] = useState(false);
  if (s.isPending)
    return (
      <Page title="Supplier" back={{ label: 'Suppliers', to: '/suppliers' }}>
        <ListSkeleton />
      </Page>
    );
  if (s.isError)
    return (
      <Page title="Supplier" back={{ label: 'Suppliers', to: '/suppliers' }}>
        <EmptyState
          icon={<IconTruck />}
          title="Couldn’t load this supplier"
          message={s.error.message}
        />
      </Page>
    );
  const sup = s.data;
  return (
    <Page
      title={sup.name}
      back={{ label: 'Suppliers', to: '/suppliers' }}
      actions={
        isOwner && (
          <Button variant="plain" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )
      }
    >
      <div className="hero">
        <div className="hero__amount">{formatPence(Math.abs(sup.spendPence))}</div>
        <div className="hero__meta">
          <span>
            {sup.spendPence < 0 ? 'in credit' : 'spent'} · {sup.priceItemCount}{' '}
            {sup.priceItemCount === 1 ? 'item' : 'items'} on the price list
          </span>
        </div>
      </div>
      <Section header="Contact">
        <List>
          <li>
            <KeyValueRow
              label="Email"
              value={sup.email ? <a href={`mailto:${sup.email}`}>{sup.email}</a> : '—'}
            />
          </li>
          <li>
            <KeyValueRow
              label="Phone"
              value={sup.phone ? <a href={`tel:${sup.phone}`}>{sup.phone}</a> : '—'}
            />
          </li>
          <li>
            <KeyValueRow label="Account no." value={sup.accountRef ?? '—'} />
          </li>
        </List>
      </Section>
      {sup.notes && (
        <Section header="Notes">
          <List>
            <li>
              <div className="row" style={{ whiteSpace: 'pre-line' }}>
                {sup.notes}
              </div>
            </li>
          </List>
        </Section>
      )}
      <Section header="Bills and credit notes">
        {bills.isPending ? (
          <ListSkeleton rows={2} />
        ) : (bills.data ?? []).length === 0 ? (
          <List>
            <li>
              <div className="row" style={{ color: 'var(--label-2)' }}>
                No bills yet.
              </div>
            </li>
          </List>
        ) : (
          <List label="Bills from this supplier">
            {(bills.data ?? []).map((b) => (
              <li key={b.id}>
                <LinkRow
                  to={`/bills/${b.id}`}
                  title={b.reference}
                  sub={
                    <>
                      {b.kind === 'credit_note' && <Pill tone="purple">Credit note</Pill>}{' '}
                      {b.status === 'draft' ? (
                        <Pill tone="orange">To check</Pill>
                      ) : (
                        <Pill tone="green">Applied</Pill>
                      )}{' '}
                      {shortDate(`${b.billDate}T12:00:00Z`)}
                      {b.jobNumber ? ` · Job ${b.jobNumber}` : ''}
                    </>
                  }
                  meta={
                    <span className="num">
                      {b.kind === 'credit_note' ? '−' : ''}
                      {formatPence(b.totalPence)}
                    </span>
                  }
                />
              </li>
            ))}
          </List>
        )}
      </Section>
      {editing && <SupplierSheet supplier={sup} onClose={() => setEditing(false)} />}
    </Page>
  );
}

function SupplierSheet(props: { supplier?: SupplierDto; onClose: () => void }) {
  const s = props.supplier;
  const save = useSaveSupplier(s);
  const toast = useToast();
  const [name, setName] = useState(s?.name ?? '');
  const [email, setEmail] = useState(s?.email ?? '');
  const [phone, setPhone] = useState(s?.phone ?? '');
  const [accountRef, setAccountRef] = useState(s?.accountRef ?? '');
  const [notes, setNotes] = useState(s?.notes ?? '');
  const fields = save.error instanceof ApiError ? save.error.fields : {};
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    save.mutate(
      { name: name.trim(), email, phone, accountRef, notes },
      {
        onSuccess: () => {
          toast.show(s ? 'Supplier saved' : `${name.trim()} added`);
          props.onClose();
        },
      },
    );
  };
  return (
    <Sheet
      open
      title={s ? 'Edit Supplier' : 'New Supplier'}
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!name.trim()}
          loading={save.isPending}
          style={{ fontWeight: 600 }}
        >
          {s ? 'Save' : 'Add'}
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section
          footer={s ? 'Renaming also updates the supplier on its price-list items.' : undefined}
        >
          <List className="form-list">
            <TextField
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={fields.name}
              data-autofocus
            />
            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fields.email}
            />
            <TextField
              label="Phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <TextField
              label="Account no."
              value={accountRef}
              onChange={(e) => setAccountRef(e.target.value)}
            />
            <TextAreaField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </List>
        </Section>
        {save.isError && !Object.keys(fields).length && (
          <p className="field-error" role="alert">
            {save.error.message}
          </p>
        )}
      </form>
    </Sheet>
  );
}
