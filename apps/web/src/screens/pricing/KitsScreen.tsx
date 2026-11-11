import { formatPence } from '@lse/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useKits, useSaveKit } from '../../api/billing';
import { useSession } from '../../api/hooks';
import { IconPlus, IconWrench } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import {
  Button,
  EmptyState,
  IconButton,
  LinkRow,
  List,
  ListSkeleton,
  Page,
  Section,
  TextField,
} from '../../components/ui';
import { Change } from './Change';

/** Reusable sets of price-list items, added to quotes as one costed block. */
export function KitsScreen() {
  const kits = useKits();
  const [adding, setAdding] = useState(false);
  const isOwner = useSession().data?.role === 'owner';
  const items = kits.data ?? [];
  return (
    <Page
      title="Kits"
      back={{ label: 'More', to: '/more' }}
      actions={
        isOwner && (
          <IconButton label="New kit" onClick={() => setAdding(true)}>
            <IconPlus />
          </IconButton>
        )
      }
    >
      {kits.isPending ? (
        <ListSkeleton />
      ) : kits.isError ? (
        <EmptyState icon={<IconWrench />} title="Couldn’t load kits" message={kits.error.message} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconWrench />}
          title="No kits yet"
          message="A kit is a set of price-list items you use together, like everything for one double socket."
          action={isOwner ? <Button onClick={() => setAdding(true)}>New Kit</Button> : undefined}
        />
      ) : (
        <Section footer="Costs follow the price list. When a price changes, the old and new kit cost are shown.">
          <List label="Kits">
            {items.map((k) => (
              <li key={k.id}>
                <LinkRow
                  to={`/kits/${k.id}`}
                  title={k.name}
                  sub={
                    k.lastChange && k.lastChange.newCostPence === k.costPence ? (
                      <>
                        {k.lineCount} items · cost{' '}
                        <Change from={k.lastChange.oldCostPence} to={k.lastChange.newCostPence} />
                      </>
                    ) : (
                      `${k.lineCount} ${k.lineCount === 1 ? 'item' : 'items'} · cost ${formatPence(k.costPence)}`
                    )
                  }
                  meta={<span className="num">{formatPence(k.sellPence)}</span>}
                />
              </li>
            ))}
          </List>
        </Section>
      )}
      {adding && <NewKitSheet onClose={() => setAdding(false)} />}
    </Page>
  );
}

function NewKitSheet({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const save = useSaveKit();
  const navigate = useNavigate();
  const fields = save.error instanceof ApiError ? save.error.fields : {};
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || save.isPending) return;
    save.mutate({ name, lines: [] }, { onSuccess: (k) => navigate(`/kits/${k.id}`) });
  };
  return (
    <Sheet
      open
      title="New Kit"
      onClose={onClose}
      action={
        <Button
          variant="plain"
          onClick={() => submit()}
          disabled={!name.trim()}
          loading={save.isPending}
          style={{ fontWeight: 600 }}
        >
          Create
        </Button>
      }
    >
      <form onSubmit={submit}>
        <Section footer="Next, add the items it contains.">
          <List className="form-list">
            <TextField
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Double socket on new radial"
              error={fields.name}
              data-autofocus
            />
          </List>
        </Section>
      </form>
    </Sheet>
  );
}
