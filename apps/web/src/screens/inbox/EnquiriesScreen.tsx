import { ENQUIRY_SOURCE_LABELS, type EnquiryCreate } from '@lse/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useCreateEnquiry, useEnquiries } from '../../api/inbox';
import { IconPlus, IconTray } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import {
  Button,
  EmptyState,
  IconButton,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
  Segmented,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { shortDate } from '../../lib/status';

const STATUS = {
  todo: { label: 'To do', tone: 'orange' },
  actioned: { label: 'Actioned', tone: 'green' },
  converted: { label: 'Converted', tone: 'blue' },
  rejected: { label: 'Rejected', tone: 'grey' },
} as const;

/** New work asking to happen: from the website form or typed in after a call. */
export function EnquiriesScreen() {
  const [which, setWhich] = useState<'todo' | 'done'>('todo');
  const [adding, setAdding] = useState(false);
  const list = useEnquiries(which);
  const items = list.data ?? [];
  return (
    <Page
      title="Enquiries"
      back={{ label: 'Home', to: '/home' }}
      actions={
        <IconButton label="New enquiry" onClick={() => setAdding(true)}>
          <IconPlus />
        </IconButton>
      }
    >
      <Segmented
        label="Show"
        value={which}
        onChange={setWhich}
        options={[
          { value: 'todo', label: 'To Do' },
          { value: 'done', label: 'Done' },
        ]}
      />
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <EmptyState
          icon={<IconTray />}
          title="Couldn’t load enquiries"
          message={list.error.message}
          action={<Button onClick={() => list.refetch()}>Try again</Button>}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconTray />}
          title={which === 'todo' ? 'All caught up' : 'Nothing done yet'}
          message="Website enquiries land here. Add one after a call with +."
          action={
            which === 'todo' ? (
              <Button onClick={() => setAdding(true)}>New Enquiry</Button>
            ) : undefined
          }
        />
      ) : (
        <Section footer={`${items.length} ${items.length === 1 ? 'enquiry' : 'enquiries'}`}>
          <List label="Enquiries">
            {items.map((e) => (
              <li key={e.id}>
                <LinkRow
                  to={`/enquiries/${e.id}`}
                  title={e.name}
                  sub={
                    <>
                      <Pill tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Pill>{' '}
                      {ENQUIRY_SOURCE_LABELS[e.source]} · {shortDate(e.createdAt)} ·{' '}
                      {e.message.slice(0, 70)}
                      {e.message.length > 70 ? '…' : ''}
                    </>
                  }
                />
              </li>
            ))}
          </List>
        </Section>
      )}
      {adding && <NewEnquirySheet onClose={() => setAdding(false)} />}
    </Page>
  );
}

const SOURCES: { value: 'phone' | 'email' | 'manual'; label: string }[] = [
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'manual', label: 'In Person' },
];

export function NewEnquirySheet(props: { onClose: () => void }) {
  const create = useCreateEnquiry();
  const navigate = useNavigate();
  const toast = useToast();
  const [f, setF] = useState<
    Required<Pick<EnquiryCreate, 'name' | 'message'>> & {
      email: string;
      phone: string;
      address: string;
      source: 'phone' | 'email' | 'manual';
    }
  >({
    name: '',
    email: '',
    phone: '',
    address: '',
    message: '',
    source: 'phone',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const fields = create.error instanceof ApiError ? create.error.fields : {};
  const submit = () =>
    create.mutate(f, {
      onSuccess: (e) => {
        toast.show('Enquiry added to To Do');
        props.onClose();
        navigate(`/enquiries/${e.id}`);
      },
    });
  return (
    <Sheet
      open
      title="New Enquiry"
      onClose={props.onClose}
      action={
        <Button
          variant="plain"
          onClick={submit}
          loading={create.isPending}
          disabled={!f.name.trim() || !f.message.trim()}
          style={{ fontWeight: 600 }}
        >
          Add
        </Button>
      }
    >
      <Segmented
        label="Came in by"
        value={f.source}
        onChange={(source) => setF({ ...f, source })}
        options={SOURCES}
      />
      <Section>
        <List className="form-list">
          <TextField
            label="Name"
            value={f.name}
            onChange={set('name')}
            error={fields.name}
            autoComplete="off"
            data-autofocus
          />
          <TextField
            label="Phone"
            type="tel"
            value={f.phone}
            onChange={set('phone')}
            error={fields.phone}
          />
          <TextField
            label="Email"
            type="email"
            value={f.email}
            onChange={set('email')}
            error={fields.email}
          />
          <TextField
            label="Address"
            value={f.address}
            onChange={set('address')}
            error={fields.address}
          />
          <TextAreaField
            label="What they need"
            value={f.message}
            onChange={set('message')}
            error={fields.message}
            rows={4}
          />
        </List>
      </Section>
      {create.isError && !Object.keys(fields).length && (
        <p className="field-error" role="alert">
          {create.error.message}
        </p>
      )}
    </Sheet>
  );
}
