import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useCreateQuote, useCustomer, useCustomers } from '../../api/hooks';
import { QUEUED_TOAST } from '../../components/PendingCreates';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, List, Section, SelectField, TextField } from '../../components/ui';

/** Pick a customer (preset when started from a customer), a site, and a short title. Lines come next. */
export function NewQuoteSheet(props: { open: boolean; onClose: () => void; customerId?: string }) {
  // Mounted only while open, so every opening starts from fresh defaults.
  return props.open ? <NewQuoteSheetInner {...props} /> : null;
}

function NewQuoteSheetInner(props: { open: boolean; onClose: () => void; customerId?: string }) {
  const [customerId, setCustomerId] = useState(props.customerId ?? '');
  // undefined = use the customer's first site (most jobs need no extra tap)
  const [chosenSite, setChosenSite] = useState<string>();
  const [title, setTitle] = useState('');
  const customers = useCustomers();
  const customer = useCustomer(customerId);
  const create = useCreateQuote();
  const navigate = useNavigate();
  const toast = useToast();
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  const sites = customerId ? (customer.data?.sites ?? []) : [];

  const siteId = chosenSite ?? sites[0]?.id ?? '';

  const close = () => {
    create.reset();
    setTitle('');
    props.onClose();
  };
  const ready = !!customerId && !!title.trim();
  const submit = () => {
    if (!ready || create.isPending) return;
    create.mutate(
      { customerId, siteId: siteId || null, title },
      {
        onSuccess: (r) => {
          close();
          if (r.status === 'queued') {
            toast.show(QUEUED_TOAST('quote'));
            navigate('/quotes');
            return;
          }
          toast.show(`Quote ${r.record.number} started`);
          navigate(`/quotes/${r.record.id}`);
        },
      },
    );
  };

  return (
    <Sheet
      open={props.open}
      onClose={close}
      title="New Quote"
      action={
        <Button
          variant="plain"
          onClick={submit}
          disabled={!ready}
          loading={create.isPending}
          style={{ fontWeight: 600 }}
        >
          Create
        </Button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Section
          footer={
            create.isError && !Object.keys(fields).length ? (
              <span style={{ color: 'var(--red)' }}>{create.error.message}</span>
            ) : (
              'You’ll add the lines next. The quote number is given when it’s created.'
            )
          }
        >
          <List className="form-list">
            <SelectField
              label="Customer"
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                setChosenSite(undefined);
              }}
              error={fields.customerId}
              disabled={!!props.customerId}
            >
              <option value="">Choose…</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
            {sites.length > 0 && (
              <SelectField
                label="Site"
                value={siteId}
                onChange={(e) => setChosenSite(e.target.value)}
                error={fields.siteId}
              >
                <option value="">No site</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label ? `${s.label}: ${s.address}` : s.address}
                  </option>
                ))}
              </SelectField>
            )}
            <TextField
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Kitchen rewire"
              error={fields.title}
              data-autofocus={props.customerId ? true : undefined}
            />
          </List>
        </Section>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
