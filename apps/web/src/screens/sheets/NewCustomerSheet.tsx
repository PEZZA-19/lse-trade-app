import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useCreateCustomer } from '../../api/hooks';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Button, List, Section, TextField } from '../../components/ui';

/** Four fields, only the name required. The address becomes both the billing address and the first site. */
export function NewCustomerSheet(props: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '' });
  const create = useCreateCustomer();
  const navigate = useNavigate();
  const toast = useToast();
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const close = () => {
    create.reset();
    setForm({ name: '', phone: '', email: '', address: '' });
    props.onClose();
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!form.name.trim() || create.isPending) return;
    const address = form.address.trim();
    create.mutate(
      {
        name: form.name,
        phone: form.phone,
        email: form.email,
        billingAddress: address,
        sites: address ? [{ address }] : [],
      },
      {
        onSuccess: (c) => {
          toast.show(`${c.name} added`);
          close();
          navigate(`/customers/${c.id}`);
        },
      },
    );
  };

  return (
    <Sheet
      open={props.open}
      onClose={close}
      title="New Customer"
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!form.name.trim()}
          loading={create.isPending}
          style={{ fontWeight: 600 }}
        >
          Add
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section
          footer={
            create.isError && !Object.keys(fields).length ? (
              <span style={{ color: 'var(--red)' }}>{create.error.message}</span>
            ) : undefined
          }
        >
          <List className="form-list">
            <TextField
              label="Name"
              value={form.name}
              onChange={set('name')}
              placeholder="Required"
              autoComplete="off"
              error={fields.name}
              data-autofocus
            />
            <TextField
              label="Phone"
              value={form.phone}
              onChange={set('phone')}
              type="tel"
              inputMode="tel"
              placeholder="Optional"
              error={fields.phone}
            />
            <TextField
              label="Email"
              value={form.email}
              onChange={set('email')}
              type="email"
              inputMode="email"
              autoCapitalize="off"
              placeholder="Optional"
              error={fields.email}
            />
            <TextField
              label="Address"
              value={form.address}
              onChange={set('address')}
              placeholder="Where the work is"
              error={fields.billingAddress}
            />
          </List>
        </Section>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
