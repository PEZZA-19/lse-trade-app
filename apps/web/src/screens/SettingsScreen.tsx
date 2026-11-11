import {
  formatDocNumber,
  formatMarkup,
  formatPence,
  parsePounds,
  parseQty,
  type SequenceDto,
  type SettingsDto,
  type SettingsUpdate,
} from '@lse/shared';
import { useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { useReadiness, useSession, useSettings, useSignOut, useUpdateSettings } from '../api/hooks';
import { SaveStatus } from '../components/SaveStatus';
import {
  Button,
  List,
  ListSkeleton,
  Page,
  Section,
  StaticRow,
  TextAreaField,
  TextField,
} from '../components/ui';

const SEQ_LABEL: Record<SequenceDto['kind'], string> = {
  quote: 'Quotes',
  job: 'Jobs',
  invoice: 'Invoices',
  credit_note: 'Credit notes',
};

type Form = Record<
  | 'name'
  | 'legalName'
  | 'address'
  | 'phone'
  | 'email'
  | 'labourRate'
  | 'markup'
  | 'quoteValidDays'
  | 'paymentTermsDays'
  | 'taxRate'
  | 'quoteTerms'
  | 'invoiceTerms'
  | 'bankAccountName'
  | 'bankSortCode'
  | 'bankAccountNumber',
  string
> & {
  sequences: { kind: SequenceDto['kind']; prefix: string; padding: string; nextValue: string }[];
};

const toForm = (s: SettingsDto): Form => ({
  name: s.name,
  legalName: s.legalName ?? '',
  address: s.address ?? '',
  phone: s.phone ?? '',
  email: s.email ?? '',
  labourRate: formatPence(s.labourRatePence).replace('£', ''),
  markup: formatMarkup(s.defaultMarkupBp),
  quoteValidDays: String(s.quoteValidDays),
  paymentTermsDays: String(s.paymentTermsDays),
  taxRate: String(s.taxRateBp / 100),
  quoteTerms: s.quoteTerms ?? '',
  invoiceTerms: s.invoiceTerms ?? '',
  bankAccountName: s.bankAccountName ?? '',
  bankSortCode: s.bankSortCode ?? '',
  bankAccountNumber: s.bankAccountNumber ?? '',
  sequences: s.sequences.map((q) => ({
    kind: q.kind,
    prefix: q.prefix,
    padding: String(q.padding),
    nextValue: String(q.nextValue),
  })),
});

const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/** Turns the form into an API patch; returns field errors for anything that isn't a valid number. */
export function formToPatch(f: Form): { patch: SettingsUpdate; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const labour = parsePounds(f.labourRate);
  if (labour === null || labour < 0) errors.labourRatePence = 'Enter an amount, e.g. 45.00';
  const markupMilli = parseQty(f.markup);
  if (markupMilli === null || markupMilli < 1000 || markupMilli > 10000)
    errors.defaultMarkupBp = 'Between 1.0 and 10';
  const tax = Number(f.taxRate.trim() || '0');
  if (!Number.isFinite(tax) || tax < 0 || tax > 100) errors.taxRateBp = 'A percentage, 0 to 100';
  const valid = int(f.quoteValidDays);
  if (valid === null) errors.quoteValidDays = 'Whole days';
  const terms = int(f.paymentTermsDays);
  if (terms === null) errors.paymentTermsDays = 'Whole days';
  const sequences = f.sequences.map((q) => {
    const padding = int(q.padding);
    const nextValue = int(q.nextValue);
    if (padding === null || nextValue === null) errors[`seq.${q.kind}`] = 'Whole numbers only';
    return {
      kind: q.kind,
      prefix: q.prefix.trim(),
      padding: padding ?? 0,
      nextValue: nextValue ?? 1,
    };
  });
  return {
    errors,
    patch: {
      name: f.name,
      legalName: f.legalName,
      address: f.address,
      phone: f.phone,
      email: f.email,
      labourRatePence: labour ?? 0,
      defaultMarkupBp: Math.round((markupMilli ?? 0) * 10),
      quoteValidDays: valid ?? 0,
      paymentTermsDays: terms ?? 0,
      taxRateBp: Math.round(tax * 100),
      quoteTerms: f.quoteTerms,
      invoiceTerms: f.invoiceTerms,
      bankAccountName: f.bankAccountName,
      bankSortCode: f.bankSortCode,
      bankAccountNumber: f.bankAccountNumber,
      sequences,
    },
  };
}

export function SettingsScreen() {
  const settings = useSettings();
  return (
    <Page title="Settings">
      {settings.data ? (
        // Remount the form when the saved settings change identity (e.g. after reload).
        <SettingsForm initial={settings.data} />
      ) : settings.isError ? (
        <p role="alert">{settings.error.message}</p>
      ) : (
        <ListSkeleton rows={6} />
      )}
      <AccountSection />
    </Page>
  );
}

function SettingsForm({ initial }: { initial: SettingsDto }) {
  const [form, setForm] = useState<Form>(() => toForm(initial));
  const [savedForm, setSavedForm] = useState<Form>(() => toForm(initial));
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const update = useUpdateSettings();
  const readiness = useReadiness();
  const session = useSession();
  const isOwner = session.data?.role === 'owner';
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(savedForm),
    [form, savedForm],
  );
  const serverFields = update.error instanceof ApiError ? update.error.fields : {};
  const err = (k: string) => localErrors[k] ?? serverFields[k];
  const set = (k: keyof Omit<Form, 'sequences'>) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const setSeq = (i: number, k: 'prefix' | 'padding' | 'nextValue', v: string) =>
    setForm((f) => ({
      ...f,
      sequences: f.sequences.map((q, j) => (j === i ? { ...q, [k]: v } : q)),
    }));

  const state = update.isPending
    ? 'saving'
    : update.isError
      ? 'error'
      : dirty
        ? 'dirty'
        : update.isSuccess
          ? 'saved'
          : 'idle';

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    const { patch, errors } = formToPatch(form);
    setLocalErrors(errors);
    if (Object.keys(errors).length) return;
    update.mutate(patch, {
      onSuccess: (s) => {
        const next = toForm(s);
        setForm(next);
        setSavedForm(next);
      },
    });
  };

  const missing = readiness.data?.quote.missing ?? [];
  const seqLast = (kind: SequenceDto['kind']) =>
    initial.sequences.find((q) => q.kind === kind)?.lastUsed ?? null;

  return (
    <form onSubmit={save} aria-label="Business settings">
      {missing.length > 0 && (
        <p className="readiness" role="note">
          <strong>Before you can send quotes:</strong> add your{' '}
          {missing.map((m) => m.label.toLowerCase()).join(', ')}.
        </p>
      )}
      <fieldset disabled={!isOwner} style={{ border: 0, padding: 0, margin: 0 }}>
        <Section header="Business" footer="Shown on quotes and invoices.">
          <List className="form-list">
            <TextField
              label="Trading name"
              value={form.name}
              onChange={set('name')}
              error={err('name')}
            />
            <TextField
              label="Legal name"
              value={form.legalName}
              onChange={set('legalName')}
              placeholder="If different"
            />
            <TextField
              label="Address"
              value={form.address}
              onChange={set('address')}
              error={err('address')}
            />
            <TextField
              label="Phone"
              type="tel"
              inputMode="tel"
              value={form.phone}
              onChange={set('phone')}
            />
            <TextField
              label="Email"
              type="email"
              inputMode="email"
              autoCapitalize="off"
              value={form.email}
              onChange={set('email')}
              error={err('email')}
            />
          </List>
        </Section>

        <Section
          header="Pricing"
          footer="Labour lines start at this rate. Markup applies to material costs."
        >
          <List className="form-list">
            <TextField
              label="Labour rate (£/hr)"
              inputMode="decimal"
              value={form.labourRate}
              onChange={set('labourRate')}
              error={err('labourRatePence')}
            />
            <TextField
              label="Default markup (×)"
              inputMode="decimal"
              value={form.markup}
              onChange={set('markup')}
              error={err('defaultMarkupBp')}
            />
            <TextField
              label="Tax rate (%)"
              inputMode="decimal"
              value={form.taxRate}
              onChange={set('taxRate')}
              error={err('taxRateBp')}
            />
            <TextField
              label="Quotes valid for (days)"
              inputMode="numeric"
              value={form.quoteValidDays}
              onChange={set('quoteValidDays')}
              error={err('quoteValidDays')}
            />
          </List>
        </Section>

        <Section header="Getting paid" footer="Needed before invoices can be sent.">
          <List className="form-list">
            <TextField
              label="Payment terms (days)"
              inputMode="numeric"
              value={form.paymentTermsDays}
              onChange={set('paymentTermsDays')}
              error={err('paymentTermsDays')}
            />
            <TextField
              label="Account name"
              value={form.bankAccountName}
              onChange={set('bankAccountName')}
            />
            <TextField
              label="Sort code"
              inputMode="numeric"
              placeholder="00-00-00"
              value={form.bankSortCode}
              onChange={set('bankSortCode')}
              error={err('bankSortCode')}
            />
            <TextField
              label="Account number"
              inputMode="numeric"
              placeholder="8 digits"
              value={form.bankAccountNumber}
              onChange={set('bankAccountNumber')}
              error={err('bankAccountNumber')}
            />
          </List>
        </Section>

        <Section header="Terms">
          <List className="form-list">
            <TextAreaField
              label="Quote terms"
              value={form.quoteTerms}
              onChange={set('quoteTerms')}
              rows={3}
            />
            <TextAreaField
              label="Invoice terms"
              value={form.invoiceTerms}
              onChange={set('invoiceTerms')}
              rows={3}
            />
          </List>
        </Section>

        <Section header="Numbering" footer="Numbers already used are never reused.">
          <List className="form-list">
            {form.sequences.map((q, i) => {
              const pad = int(q.padding) ?? 0;
              const next = int(q.nextValue) ?? 1;
              const last = seqLast(q.kind);
              return (
                <li key={q.kind}>
                  <fieldset className="seq" aria-label={SEQ_LABEL[q.kind]}>
                    <legend className="seq__title">
                      {SEQ_LABEL[q.kind]}{' '}
                      <span className="seq__preview">
                        Next: {formatDocNumber(q.prefix, pad, next)}
                      </span>
                    </legend>
                    <List className="form-list">
                      <TextField
                        label="Prefix"
                        value={q.prefix}
                        onChange={(e) => setSeq(i, 'prefix', e.target.value)}
                      />
                      <TextField
                        label="Digits"
                        inputMode="numeric"
                        value={q.padding}
                        onChange={(e) => setSeq(i, 'padding', e.target.value)}
                      />
                      <TextField
                        label="Next number"
                        inputMode="numeric"
                        value={q.nextValue}
                        onChange={(e) => setSeq(i, 'nextValue', e.target.value)}
                        error={err(`seq.${q.kind}`)}
                      />
                    </List>
                    {last !== null && (
                      <p className="send-blocked">
                        Last used: {formatDocNumber(q.prefix, pad, last)}
                      </p>
                    )}
                  </fieldset>
                </li>
              );
            })}
          </List>
        </Section>
      </fieldset>

      <div className="action-bar">
        <SaveStatus state={state} errorMessage={update.error ? update.error.message : undefined} />
        {isOwner ? (
          <Button type="submit" loading={update.isPending} disabled={!dirty}>
            Save
          </Button>
        ) : (
          <span className="send-blocked">Only the owner can change settings.</span>
        )}
      </div>
    </form>
  );
}

function AccountSection() {
  const session = useSession();
  const signOut = useSignOut();
  if (!session.data) return null;
  return (
    <Section header="Account" footer={signOut.isError ? signOut.error.message : undefined}>
      <List>
        <li>
          <StaticRow>
            <span>
              Signed in as <strong>{session.data.user.email}</strong>
            </span>
          </StaticRow>
        </li>
      </List>
      <Button
        variant="destructive"
        block
        loading={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        Sign out
      </Button>
    </Section>
  );
}
