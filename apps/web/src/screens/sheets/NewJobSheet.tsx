import { PLACES_OF_WORK } from '@lse/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useCreateJob, useCustomer, useCustomers } from '../../api/hooks';
import { QUEUED_TOAST } from '../../components/PendingCreates';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, List, Section, SelectField, TextField } from '../../components/ui';

const PLACE_LABEL: Record<(typeof PLACES_OF_WORK)[number], string> = {
  sark: 'Sark',
  guernsey: 'Guernsey',
  other: 'Elsewhere',
};

/** A job without a quote, for call-outs and small jobs. */
export function NewJobSheet(props: { open: boolean; onClose: () => void; customerId?: string }) {
  // Mounted only while open, so every opening starts from fresh defaults.
  return props.open ? <NewJobSheetInner {...props} /> : null;
}

function NewJobSheetInner(props: { open: boolean; onClose: () => void; customerId?: string }) {
  const [customerId, setCustomerId] = useState(props.customerId ?? '');
  // undefined = use the customer's first site (most jobs need no extra tap)
  const [chosenSite, setChosenSite] = useState<string>();
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState<(typeof PLACES_OF_WORK)[number]>('sark');
  const customers = useCustomers();
  const customer = useCustomer(customerId);
  const create = useCreateJob();
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
      { customerId, siteId: siteId || null, title, placeOfWork: place },
      {
        onSuccess: (r) => {
          close();
          if (r.status === 'queued') {
            toast.show(QUEUED_TOAST('job'));
            navigate('/jobs');
            return;
          }
          toast.show(`Job ${r.record.number} created`);
          navigate(`/jobs/${r.record.id}`);
        },
      },
    );
  };

  return (
    <Sheet
      open={props.open}
      onClose={close}
      title="New Job"
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
              'For call-outs and small jobs. Jobs from a quote are created on the quote.'
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
              label="What’s the job?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. No power to shed"
              error={fields.title}
            />
            <SelectField
              label="Where"
              value={place}
              onChange={(e) => setPlace(e.target.value as typeof place)}
            >
              {PLACES_OF_WORK.map((p) => (
                <option key={p} value={p}>
                  {PLACE_LABEL[p]}
                </option>
              ))}
            </SelectField>
          </List>
        </Section>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
