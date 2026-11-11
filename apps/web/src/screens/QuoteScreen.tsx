import {
  formatPence,
  formatQty,
  quoteTotals,
  type QuoteDetailDto,
  type QuoteLineInput,
} from '@lse/shared';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError } from '../api/client';
import {
  useConvertQuote,
  useMe,
  useQuote,
  useQuoteAction,
  useReadiness,
  useUpdateQuote,
} from '../api/hooks';
import { IconJobs, IconPlusCircle, IconQuotes } from '../components/icons';
import { SaveStatus } from '../components/SaveStatus';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import {
  Button,
  ButtonRow,
  EmptyState,
  KeyValueRow,
  List,
  ListSkeleton,
  Page,
  Pill,
  Section,
  TextAreaField,
  TextField,
} from '../components/ui';
import { LINE_KIND_LABEL, QUOTE_STATUS } from '../lib/status';
import { useSerialSave } from '../lib/useSerialSave';
import { LineSheet } from './sheets/LineSheet';

const toInput = (q: QuoteDetailDto): QuoteLineInput[] =>
  q.current.lines.map((l) => ({
    kind: l.kind,
    description: l.description,
    qtyMilli: l.qtyMilli,
    unitCostPence: l.unitCostPence,
    markupBp: l.markupBp,
    unitPricePence: l.unitPricePence,
    optionLabel: l.optionLabel,
    taxRateBp: l.taxRateBp,
  }));

export function QuoteScreen() {
  const { id = '' } = useParams();
  const quote = useQuote(id);
  if (quote.isPending)
    return (
      <Page title="" back={{ label: 'Quotes', to: '/quotes' }}>
        <ListSkeleton rows={4} />
      </Page>
    );
  if (quote.isError)
    return (
      <Page title="Quote" back={{ label: 'Quotes', to: '/quotes' }}>
        <EmptyState
          icon={<IconQuotes />}
          title="Couldn’t load this quote"
          message={quote.error.message}
          action={<Button onClick={() => quote.refetch()}>Try again</Button>}
        />
      </Page>
    );
  return (
    <QuoteEditor
      key={`${quote.data.id}:${quote.data.currentRevision}:${quote.data.status}`}
      quote={quote.data}
    />
  );
}

function QuoteEditor({ quote: q }: { quote: QuoteDetailDto }) {
  const me = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const update = useUpdateQuote(q.id);
  const action = useQuoteAction(q.id);
  const convert = useConvertQuote(q.id);
  const readiness = useReadiness();
  const readinessMissing = readiness.data?.quote.missing ?? [];
  const notReady = readinessMissing.length > 0;
  const editable = q.status === 'draft';
  const labourRate = me.data?.tenant.labourRatePence ?? 4500;

  // Local copy so edits feel instant; the server copy stays the source of truth.
  const [lines, setLines] = useState<QuoteLineInput[]>(() => toInput(q));
  const [title, setTitle] = useState(q.title);
  const [notes, setNotes] = useState(q.current.notes ?? '');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [accepting, setAccepting] = useState(false);

  const sendPatch = useCallback(
    (patch: Parameters<typeof update.mutateAsync>[0]) => update.mutateAsync(patch),
    [update],
  );
  const saver = useSerialSave(sendPatch);

  const defaultMarkupBp = q.current.defaultMarkupBp;
  const acceptedOptions = q.current.acceptedOptions;
  // Totals computed locally with the same shared rules the server uses.
  const totals = useMemo(
    () =>
      quoteTotals(
        lines.map((l) => ({
          kind: l.kind,
          qtyMilli: l.qtyMilli ?? 1000,
          unitCostPence: l.unitCostPence ?? null,
          markupBp: l.markupBp ?? null,
          unitPricePence: l.unitPricePence ?? null,
          optionLabel: l.optionLabel ?? null,
        })),
        { markupBp: defaultMarkupBp },
        acceptedOptions,
      ),
    [lines, defaultMarkupBp, acceptedOptions],
  );
  const serverLines = q.current.lines;
  const optionLabels = Object.keys(totals.options);

  const commitLines = (next: QuoteLineInput[]) => {
    setLines(next);
    saver.save({ lines: next });
  };

  const run = (a: 'send' | 'revise' | 'decline', done: string) =>
    action.mutate(
      { action: a },
      {
        onSuccess: () => toast.show(done),
        onError: (e) => toast.show(e.message, { tone: 'error' }),
      },
    );

  const doConvert = () =>
    convert.mutate(undefined, {
      onSuccess: (job) => {
        toast.show(`Job ${job.number} created`);
        navigate(`/jobs/${job.id}`);
      },
      onError: (e) => {
        if (e instanceof ApiError && e.code === 'already_converted') {
          const details = e.details as { jobId?: string } | undefined;
          if (details?.jobId) navigate(`/jobs/${details.jobId}`);
        }
        toast.show(e.message, { tone: 'error' });
      },
    });

  const busy = action.isPending || convert.isPending || saver.state === 'saving';
  const status = QUOTE_STATUS[q.status];

  const primary = {
    draft: (
      <>
        <Button
          large
          block
          onClick={() => run('send', 'Marked as sent')}
          loading={action.isPending}
          disabled={busy || lines.length === 0 || totals.corePence <= 0 || notReady}
        >
          Mark as sent
        </Button>
        {notReady && (
          <p className="send-blocked" role="note">
            Add your {readinessMissing.map((m) => m.label.toLowerCase()).join(', ')} in{' '}
            <Link to="/settings">Settings</Link> first, so the customer knows who it’s from.
          </p>
        )}
      </>
    ),
    sent: (
      <Button large block onClick={() => setAccepting(true)} disabled={busy}>
        Customer said yes
      </Button>
    ),
    accepted: (
      <Button large block onClick={doConvert} loading={convert.isPending} disabled={busy}>
        Create job
      </Button>
    ),
    converted: null,
    declined: (
      <Button
        large
        block
        variant="secondary"
        onClick={() => run('revise', 'New revision started')}
        loading={action.isPending}
      >
        Make a new revision
      </Button>
    ),
    expired: (
      <Button
        large
        block
        variant="secondary"
        onClick={() => run('revise', 'New revision started')}
        loading={action.isPending}
      >
        Make a new revision
      </Button>
    ),
  }[q.status];

  const hint = {
    draft:
      lines.length === 0
        ? 'Add your lines, then mark it as sent once it’s gone to the customer.'
        : 'This records that you’ve sent it. Emailing from the app comes later, always after your approval.',
    sent: 'Record which extras they chose. You can turn it into a job straight after.',
    accepted:
      'Creates the next job number, copies the customer, site and accepted lines, and links the two.',
    converted: undefined,
    declined: undefined,
    expired: undefined,
  }[q.status];

  const renderLine = (l: QuoteLineInput, i: number) => {
    const server = serverLines[i];
    const sell = server && server.description === l.description ? server.unitSellPence : undefined;
    const unit = l.kind === 'labour' ? 'h' : '';
    const row = (
      <>
        <span className="row__main">
          <span className="row__title">{l.description}</span>
          <span className="row__sub">
            {LINE_KIND_LABEL[l.kind]}
            {(l.kind === 'labour' || l.kind === 'material') &&
              ` · ${formatQty(l.qtyMilli ?? 1000)}${unit}`}
            {sell !== undefined && (l.kind === 'labour' || l.kind === 'material')
              ? ` × ${formatPence(sell)}`
              : ''}
          </span>
        </span>
        <span className="row__meta num" style={{ color: 'var(--label)' }}>
          {formatPence(lineTotalOf(l, q.current.defaultMarkupBp))}
        </span>
      </>
    );
    return (
      <li key={i}>
        {editable ? (
          <button type="button" className="row" onClick={() => setEditing(i)}>
            {row}
          </button>
        ) : (
          <div className="row">{row}</div>
        )}
      </li>
    );
  };

  const core = lines.map((l, i) => [l, i] as const).filter(([l]) => !l.optionLabel);

  return (
    <Page
      title={q.displayNumber}
      subtitle={
        <>
          <Link to={`/customers/${q.customerId}`}>{q.customerName}</Link>
          {q.site ? ` · ${q.site.label ?? q.site.address}` : ''}
        </>
      }
      back={{ label: 'Quotes', to: '/quotes' }}
      actions={
        <SaveStatus
          state={saver.state}
          onRetry={saver.retry}
          errorMessage={saver.error ? `Not saved: ${saver.error}` : undefined}
        />
      }
    >
      <div className="hero">
        <div className="hero__amount" aria-label={`Total ${formatPence(totals.totalPence)}`}>
          {formatPence(totals.totalPence)}
        </div>
        <div className="hero__meta">
          <Pill tone={status.tone}>{status.label}</Pill>
          <span>Rev {q.current.revisionLetter}</span>
          <span>·</span>
          <span>Valid {q.current.validDays} days</span>
          {optionLabels.length > 0 && q.status !== 'accepted' && q.status !== 'converted' && (
            <span>
              · {optionLabels.length} optional {optionLabels.length === 1 ? 'extra' : 'extras'}
            </span>
          )}
        </div>
      </div>

      {q.status === 'converted' && q.convertedJobId && (
        <Section>
          <List>
            <li>
              <Link className="row" to={`/jobs/${q.convertedJobId}`}>
                <IconJobs width={22} height={22} color="var(--accent)" />
                <span className="row__main">
                  <span className="row__title">Job {q.convertedJobNumber}</span>
                  <span className="row__sub">
                    Created from this quote. Make changes on the job.
                  </span>
                </span>
              </Link>
            </li>
          </List>
        </Section>
      )}

      {(primary || q.status === 'sent') && (
        <div className="action-bar">
          {primary}
          {q.status === 'sent' && (
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button
                variant="secondary"
                style={{ flex: 1 }}
                onClick={() => run('revise', 'New revision started')}
                disabled={busy}
              >
                Make changes
              </Button>
              <Button
                variant="secondary"
                style={{ flex: 1 }}
                onClick={() => run('decline', 'Marked as declined')}
                disabled={busy}
              >
                Declined
              </Button>
            </div>
          )}
          {hint && (
            <p className="section__footer" style={{ padding: '0 var(--space-4)' }}>
              {hint}
            </p>
          )}
        </div>
      )}

      {editable && (
        <Section header="Details">
          <List className="form-list">
            <TextField
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title !== q.title && saver.save({ title })}
            />
            <TextAreaField
              label="Notes for the customer"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => notes !== (q.current.notes ?? '') && saver.save({ notes })}
            />
          </List>
        </Section>
      )}

      <Section header="Work">
        <List label="Quote lines">
          {core.map(([l, i]) => renderLine(l, i))}
          {core.length === 0 && !editable && (
            <li>
              <div className="row" style={{ color: 'var(--label-2)' }}>
                No lines
              </div>
            </li>
          )}
          {editable && (
            <li>
              <ButtonRow
                onClick={() => setEditing('new')}
                lead={<IconPlusCircle width={22} height={22} color="var(--accent)" />}
                title={<span style={{ color: 'var(--accent)' }}>Add line</span>}
              />
            </li>
          )}
        </List>
      </Section>

      {optionLabels.map((label) => (
        <Section
          key={label}
          header={`Optional: ${label}`}
          aside={
            q.current.acceptedOptions.includes(label) ? <Pill tone="green">Chosen</Pill> : undefined
          }
        >
          <List>
            {lines
              .map((l, i) => [l, i] as const)
              .filter(([l]) => l.optionLabel === label)
              .map(([l, i]) => renderLine(l, i))}
          </List>
        </Section>
      ))}

      <Section header="Totals">
        <List>
          <li>
            <KeyValueRow label="Main work" value={formatPence(totals.corePence)} />
          </li>
          {optionLabels.map((label) => (
            <li key={label}>
              <KeyValueRow
                label={`${label}${q.current.acceptedOptions.includes(label) ? '' : ' (optional)'}`}
                value={formatPence(totals.options[label]!)}
              />
            </li>
          ))}
          <li>
            <KeyValueRow label="Total" value={formatPence(totals.totalPence)} strong />
          </li>
        </List>
      </Section>

      {q.revisions.length > 1 && (
        <Section header="History">
          <List>
            {q.revisions.map((r) => (
              <li key={r.id}>
                <KeyValueRow
                  label={`Rev ${r.revisionLetter}`}
                  value={r.supersededAt ? 'Replaced' : r.sentAt ? 'Sent' : 'Current draft'}
                />
              </li>
            ))}
          </List>
        </Section>
      )}

      <LineSheet
        open={editing !== null}
        line={typeof editing === 'number' ? lines[editing] : undefined}
        defaultMarkupBp={q.current.defaultMarkupBp}
        labourRatePence={labourRate}
        existingOptions={optionLabels}
        onClose={() => setEditing(null)}
        onSave={(line) =>
          commitLines(
            editing === 'new' || editing === null
              ? [...lines, line]
              : lines.map((l, i) => (i === editing ? line : l)),
          )
        }
        onDelete={
          typeof editing === 'number'
            ? () => {
                const removed = lines[editing]!;
                const at = editing;
                const next = lines.filter((_, i) => i !== at);
                commitLines(next);
                toast.show('Line deleted', {
                  action: {
                    label: 'Undo',
                    onAction: () => commitLines([...next.slice(0, at), removed, ...next.slice(at)]),
                  },
                });
              }
            : undefined
        }
      />
      <AcceptSheet
        open={accepting}
        onClose={() => setAccepting(false)}
        quote={q}
        options={optionLabels}
        totals={totals}
        onAccepted={() => toast.show('Accepted. You can now create the job.')}
      />
    </Page>
  );
}

function lineTotalOf(l: QuoteLineInput, markupBp: number) {
  return quoteTotals(
    [
      {
        kind: l.kind,
        qtyMilli: l.qtyMilli ?? 1000,
        unitCostPence: l.unitCostPence ?? null,
        markupBp: l.markupBp ?? null,
        unitPricePence: l.unitPricePence ?? null,
        optionLabel: null,
      },
    ],
    { markupBp },
  ).corePence;
}

function AcceptSheet(props: {
  open: boolean;
  onClose: () => void;
  quote: QuoteDetailDto;
  options: string[];
  totals: { corePence: number; options: Record<string, number> };
  onAccepted: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const action = useQuoteAction(props.quote.id);
  const total =
    props.totals.corePence + chosen.reduce((s, o) => s + (props.totals.options[o] ?? 0), 0);
  const close = () => {
    action.reset();
    setChosen([]);
    props.onClose();
  };
  return (
    <Sheet
      open={props.open}
      onClose={close}
      title="Customer Said Yes"
      action={
        <Button
          variant="plain"
          style={{ fontWeight: 600 }}
          loading={action.isPending}
          onClick={() =>
            action.mutate(
              { action: 'accept', acceptedOptions: chosen },
              {
                onSuccess: () => {
                  close();
                  props.onAccepted();
                },
              },
            )
          }
        >
          Accept
        </Button>
      }
    >
      {props.options.length > 0 ? (
        <Section header="Which extras did they choose?">
          <List>
            {props.options.map((o) => {
              const on = chosen.includes(o);
              return (
                <li key={o}>
                  <label className="row" style={{ cursor: 'pointer' }}>
                    <span className="row__main">{o}</span>
                    <span className="row__meta num">
                      {formatPence(props.totals.options[o] ?? 0)}
                    </span>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setChosen((c) => (on ? c.filter((x) => x !== o) : [...c, o]))}
                      style={{ width: 22, height: 22, accentColor: 'var(--accent)' }}
                    />
                  </label>
                </li>
              );
            })}
          </List>
        </Section>
      ) : (
        <Section footer="This records the acceptance against this revision.">
          <span />
        </Section>
      )}
      <Section
        footer={
          action.isError ? (
            <span style={{ color: 'var(--red)' }}>{action.error.message}</span>
          ) : undefined
        }
      >
        <List>
          <li>
            <KeyValueRow label="Agreed total" value={formatPence(total)} strong />
          </li>
        </List>
      </Section>
    </Sheet>
  );
}
