import {
  formatDocNumber,
  formatMarkup,
  formatPence,
  parsePounds,
  validMonthDay,
  parseQty,
  type SequenceDto,
  type SettingsDto,
  type SettingsUpdate,
} from '@lse/shared';
import { useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import {
  useReadiness,
  useSession,
  useSetLogo,
  useSettings,
  useSignOut,
  useUpdateSettings,
} from '../api/hooks';
import { useEnquiryForm, useSetEnquiryForm } from '../api/inbox';
import { resizeLogo } from '../lib/image';
import { useToast } from '../components/Toast';
import { SaveStatus } from '../components/SaveStatus';
import { JobStagesSection } from './JobStagesSection';
import { TeamSection } from './TeamSection';
import { useSync } from '../offline';
import {
  Button,
  KeyValueRow,
  List,
  ListSkeleton,
  Page,
  Section,
  SelectField,
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
  | 'bankAccountNumber'
  | 'yearStartMonth'
  | 'yearStartDay'
  | 'yearEffectiveFrom',
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
  yearStartMonth: s.yearStart.slice(0, 2),
  yearStartDay: s.yearStart.slice(3, 5),
  yearEffectiveFrom: s.yearEffectiveFrom,
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
  const yearStart = `${f.yearStartMonth}-${f.yearStartDay}`;
  if (!validMonthDay(yearStart)) errors.yearStart = 'That day isn’t in that month';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.yearEffectiveFrom)) errors.yearEffectiveFrom = 'Pick a date';
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
      yearStart,
      yearEffectiveFrom: f.yearEffectiveFrom,
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
      <JobStagesSection />
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
      <LogoSection logo={initial.logoDataUrl} name={initial.name} isOwner={isOwner} />
      {isOwner && <EnquiryFormSection />}
      {isOwner && <TeamSection />}
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

        <Section
          header="Reports"
          footer={`“This Year” in Reports starts on this day from ${formatDay(form.yearEffectiveFrom)}. Before then it is the calendar year, so earlier reports never change.`}
        >
          <List className="form-list">
            <SelectField
              label="Year starts (month)"
              value={form.yearStartMonth}
              onChange={set('yearStartMonth')}
            >
              {MONTHS.map((m, i) => (
                <option key={m} value={String(i + 1).padStart(2, '0')}>
                  {m}
                </option>
              ))}
            </SelectField>
            <SelectField
              label="Year starts (day)"
              value={form.yearStartDay}
              onChange={set('yearStartDay')}
              error={err('yearStart')}
            >
              {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map((d) => (
                <option key={d} value={d}>
                  {Number(d)}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Applies from"
              type="date"
              value={form.yearEffectiveFrom}
              onChange={set('yearEffectiveFrom')}
              error={err('yearEffectiveFrom')}
            />
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

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const formatDay = (iso: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : 'the date below';

function AccountSection() {
  const session = useSession();
  const signOut = useSignOut();
  const sync = useSync();
  const [confirming, setConfirming] = useState(false);
  if (!session.data) return null;
  const unsynced = sync.ops.length;
  const onSignOut = () => {
    if (unsynced && !confirming) return setConfirming(true);
    signOut.mutate();
  };
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
      {confirming && unsynced > 0 && (
        <p className="readiness" role="alert">
          <strong>
            {unsynced} change{unsynced === 1 ? ' hasn’t' : 's haven’t'} reached the server yet.
          </strong>{' '}
          Signing out deletes {unsynced === 1 ? 'it' : 'them'} from this device. Get signal and let
          it sync first, or tap again to discard.
        </p>
      )}
      <Button variant="destructive" block loading={signOut.isPending} onClick={onSignOut}>
        {confirming && unsynced ? 'Sign out and discard' : 'Sign out'}
      </Button>
    </Section>
  );
}

/** Logo on quotes, invoices and credit notes. Resized on the device; saved straight away. */
function LogoSection(props: { logo: string | null; name: string; isOwner: boolean }) {
  const setLogo = useSetLogo();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await resizeLogo(file);
      setLogo.mutate(dataUrl, {
        onSuccess: () => toast.show('Logo saved · shown on new PDFs'),
        onError: (e) => setError(e.message),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Section
      header="Logo"
      footer={
        props.logo
          ? 'Shown at the top of quotes, invoices and credit notes.'
          : 'Without a logo, documents show your initials in a blue square.'
      }
    >
      <List>
        <li>
          <div className="row logo-row">
            {props.logo ? (
              <img className="logo-row__img" src={props.logo} alt={`${props.name} logo`} />
            ) : (
              <span className="row__title" style={{ color: 'var(--label-2)' }}>
                No logo yet
              </span>
            )}
          </div>
        </li>
        {props.isOwner && (
          <li>
            <label className="row row--button" style={{ cursor: 'pointer' }}>
              <span className="row__title" style={{ color: 'var(--accent)' }}>
                {setLogo.isPending ? 'Saving…' : props.logo ? 'Change Logo…' : 'Choose Logo…'}
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                hidden
                aria-label="Logo image"
                onChange={(e) => {
                  void pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          </li>
        )}
        {props.isOwner && props.logo && (
          <li>
            <button
              type="button"
              className="row"
              onClick={() => setLogo.mutate(null, { onSuccess: () => toast.show('Logo removed') })}
            >
              <span className="row__title" style={{ color: 'var(--red)' }}>
                Remove Logo
              </span>
            </button>
          </li>
        )}
      </List>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

/** The website enquiry form: a private address Joe's website posts to. */
function EnquiryFormSection() {
  const form = useEnquiryForm();
  const set = useSetEnquiryForm();
  const toast = useToast();
  const url = form.data?.endpoint ? `${window.location.origin}${form.data.endpoint}` : null;
  const snippet = url
    ? `<form method="post" action="${url}">\n  <input name="name" required> <input name="email" type="email"> <input name="phone">\n  <textarea name="message" required></textarea>\n  <input name="website" hidden tabindex="-1" autocomplete="off">\n  <!-- Cloudflare Turnstile widget goes here -->\n</form>`
    : '';
  return (
    <Section
      header="Website enquiry form"
      footer={
        url
          ? 'Posts land in Enquiries › To Do. Spam is filtered (hidden field, timing, links) and rate-limited; the Turnstile check is a stub until a Cloudflare account exists. New Address stops the old one working.'
          : 'Lets your website send enquiries straight into the app.'
      }
    >
      <List className="form-list" label="Website enquiry form">
        <KeyValueRow label="Status" value={form.isPending ? '…' : url ? 'On' : 'Off'} />
        {url && (
          <li className="row">
            <code className="code-block" aria-label="Form address">
              {url}
            </code>
          </li>
        )}
        {url && (
          <li className="row">
            <pre className="code-block" aria-label="Form HTML">
              {snippet}
            </pre>
          </li>
        )}
      </List>
      <div className="button-stack">
        <Button
          variant="secondary"
          block
          loading={set.isPending && set.variables === true}
          onClick={() =>
            set.mutate(true, {
              onSuccess: () =>
                toast.show(
                  url ? 'New address made; the old one no longer works' : 'Website form turned on',
                ),
            })
          }
        >
          {url ? 'New Address' : 'Turn On Website Form'}
        </Button>
        {url && (
          <Button
            variant="plain"
            block
            onClick={() =>
              set.mutate(false, { onSuccess: () => toast.show('Website form turned off') })
            }
          >
            Turn Off
          </Button>
        )}
      </div>
    </Section>
  );
}
