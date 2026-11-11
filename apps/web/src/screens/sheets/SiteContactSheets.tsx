import { CONTACT_ROLE_LABELS, CONTACT_ROLES, type ContactRole, type SiteDto } from '@lse/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { keys } from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, List, Section, SelectField, TextField } from '../../components/ui';

export function AddSiteSheet(props: { open: boolean; onClose: () => void; customerId: string }) {
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => api('POST', `/customers/${props.customerId}/sites`, { label, address }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.customer(props.customerId) });
      toast.show('Site added');
      close();
    },
  });
  const close = () => {
    m.reset();
    setLabel('');
    setAddress('');
    props.onClose();
  };
  const fields = m.error instanceof ApiError ? m.error.fields : {};
  return (
    <Sheet
      open={props.open}
      onClose={close}
      title="New Site"
      action={
        <Button
          variant="plain"
          onClick={() => m.mutate()}
          disabled={!address.trim()}
          loading={m.isPending}
          style={{ fontWeight: 600 }}
        >
          Add
        </Button>
      }
    >
      <Section
        footer={
          m.isError && !Object.keys(fields).length ? (
            <span style={{ color: 'var(--red)' }}>{m.error.message}</span>
          ) : undefined
        }
      >
        <List className="form-list">
          <TextField
            label="Address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Required"
            error={fields.address}
            data-autofocus
          />
          <TextField
            label="Name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Barn (optional)"
          />
        </List>
      </Section>
    </Sheet>
  );
}

export function AddContactSheet(props: {
  open: boolean;
  onClose: () => void;
  customerId: string;
  sites: SiteDto[];
}) {
  const empty = { name: '', role: 'site_contact' as ContactRole, phone: '', email: '', siteId: '' };
  const [f, setF] = useState(empty);
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () =>
      api('POST', `/customers/${props.customerId}/contacts`, { ...f, siteId: f.siteId || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.customer(props.customerId) });
      toast.show('Contact added');
      close();
    },
  });
  const close = () => {
    m.reset();
    setF(empty);
    props.onClose();
  };
  const fields = m.error instanceof ApiError ? m.error.fields : {};
  return (
    <Sheet
      open={props.open}
      onClose={close}
      title="New Contact"
      action={
        <Button
          variant="plain"
          onClick={() => m.mutate()}
          disabled={!f.name.trim()}
          loading={m.isPending}
          style={{ fontWeight: 600 }}
        >
          Add
        </Button>
      }
    >
      <Section
        footer={
          m.isError && !Object.keys(fields).length ? (
            <span style={{ color: 'var(--red)' }}>{m.error.message}</span>
          ) : (
            'Invoices go to whoever pays the bills. Job messages can go to the on-site contact.'
          )
        }
      >
        <List className="form-list">
          <TextField
            label="Name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder="Required"
            error={fields.name}
            data-autofocus
          />
          <SelectField
            label="Role"
            value={f.role}
            onChange={(e) => setF({ ...f, role: e.target.value as ContactRole })}
          >
            {CONTACT_ROLES.map((r) => (
              <option key={r} value={r}>
                {CONTACT_ROLE_LABELS[r]}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Phone"
            type="tel"
            inputMode="tel"
            value={f.phone}
            onChange={(e) => setF({ ...f, phone: e.target.value })}
            placeholder="Optional"
            error={fields.phone}
          />
          <TextField
            label="Email"
            type="email"
            inputMode="email"
            autoCapitalize="off"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            placeholder="Optional"
            error={fields.email}
          />
          {props.sites.length > 0 && (
            <SelectField
              label="Site"
              value={f.siteId}
              onChange={(e) => setF({ ...f, siteId: e.target.value })}
            >
              <option value="">All sites</option>
              {props.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label ?? s.address}
                </option>
              ))}
            </SelectField>
          )}
        </List>
      </Section>
    </Sheet>
  );
}
