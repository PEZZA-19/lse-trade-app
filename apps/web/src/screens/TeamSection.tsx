import {
  ACCESS_AREAS,
  AREA_LABEL,
  PRESET_AREAS,
  PRESET_LABEL,
  presetOf,
  type AccessArea,
  type AccessPreset,
  type MemberAccessDto,
  costRate,
  formatPence,
  formatPercentBp,
  onCostFromPercent,
  parsePercentBp,
  parsePounds,
  type OnCostMode,
  type TeamMemberDto,
} from '@lse/shared';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useMe } from '../api/hooks';
import {
  useAccessList,
  useSetAccess,
  useSetChargeOut,
  useSetMemberCost,
  useTeam,
} from '../api/team';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import {
  Button,
  ButtonRow,
  KeyValueRow,
  List,
  Pill,
  Section,
  Segmented,
  StaticRow,
  TextField,
} from '../components/ui';

const ROLE: Record<string, string> = {
  owner: 'Owner',
  staff: 'Staff',
  subcontractor: 'Subcontractor',
  accountant: 'Accountant',
};
const pounds = (p: number | null) => (p === null ? '' : formatPence(p).replace('£', ''));

/**
 * Settings › Team: each person's charge-out rate beside what they really cost per hour
 * (base + tax/on-costs). Reports and job costs use the cost rate for true profit. Anyone with
 * cost-rate access sees it; only admins change it.
 */
export function TeamSection({ canEdit }: { canEdit: boolean }) {
  const team = useTeam();
  const [editing, setEditing] = useState<TeamMemberDto | null>(null);
  return (
    <Section
      header="Team"
      footer="Charge-out is what customers pay per hour (your labour rate). Cost is what an hour of that person really costs you: base pay plus tax and on-costs. Profit in Reports uses the cost."
    >
      <List label="Team">
        {(team.data ?? []).map((m) => (
          <li key={m.userId}>
            {canEdit ? (
              <ButtonRow
                onClick={() => setEditing(m)}
                chevron
                title={
                  <>
                    {m.name} {m.isPlaceholder && <Pill tone="orange">Placeholder</Pill>}
                  </>
                }
                sub={teamSub(m)}
                meta={<CostMeta m={m} />}
              />
            ) : (
              <StaticRow>
                <span className="row__main">
                  <span className="row__title">{m.name}</span>
                  <span className="row__sub">{teamSub(m)}</span>
                </span>
                <CostMeta m={m} />
              </StaticRow>
            )}
          </li>
        ))}
      </List>
      {team.isError && (
        <p className="field-error" role="alert">
          {team.error.message}
        </p>
      )}
      {editing && <CostSheet m={editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

const teamSub = (m: TeamMemberDto) =>
  `${ROLE[m.role] ?? m.role} · charge-out ${formatPence(m.chargeOutPence)}/h`;

function CostMeta({ m }: { m: TeamMemberDto }) {
  return m.costRatePence === null ? (
    <span className="team-cost team-cost--unset">Cost not set</span>
  ) : (
    <span className="team-cost">{formatPence(m.costRatePence)}/h cost</span>
  );
}

const PRESETS: AccessPreset[] = ['admin', 'office', 'field', 'subcontractor'];
const accessSub = (a: MemberAccessDto) =>
  a.isAdmin
    ? 'Admin · sees everything, manages access'
    : `${PRESET_LABEL[a.preset]} · ${
        a.areas.length
          ? a.areas.map((x) => AREA_LABEL[x].title).join(', ')
          : 'jobs, schedule and time only'
      }`;

/** Settings › Access (admins only): who can see accounts, reports, cost rates, quotes and settings. */
export function AccessSection() {
  const list = useAccessList();
  const [editing, setEditing] = useState<MemberAccessDto | null>(null);
  return (
    <Section
      header="Access"
      footer="Choose what each person can open. Everyone sees jobs, the schedule, customers and their own time. The owner is always an admin."
    >
      <List label="Access">
        {(list.data ?? []).map((a) => (
          <li key={a.userId}>
            <ButtonRow
              onClick={() => setEditing(a)}
              chevron
              title={a.name}
              sub={accessSub(a)}
              meta={
                <span className="team-cost">{a.isAdmin ? 'Admin' : PRESET_LABEL[a.preset]}</span>
              }
            />
          </li>
        ))}
      </List>
      {list.isError && (
        <p className="field-error" role="alert">
          {list.error.message}
        </p>
      )}
      {editing && <AccessSheet a={editing} onClose={() => setEditing(null)} />}
    </Section>
  );
}

function AccessSheet({ a, onClose }: { a: MemberAccessDto; onClose: () => void }) {
  const [isAdmin, setIsAdmin] = useState(a.isAdmin);
  const [areas, setAreas] = useState<AccessArea[]>(a.areas);
  const save = useSetAccess(a.userId);
  const toast = useToast();
  const owner = a.role === 'owner';
  const preset = presetOf({ isAdmin, areas });
  const pick = (p: AccessPreset) => {
    setIsAdmin(p === 'admin');
    setAreas([...PRESET_AREAS[p as Exclude<AccessPreset, 'custom'>]]);
  };
  const toggle = (x: AccessArea, on: boolean) =>
    setAreas((cur) => ACCESS_AREAS.filter((y) => (y === x ? on : cur.includes(y))));
  const onSave = () =>
    save.mutate(
      { isAdmin, areas: isAdmin ? [...ACCESS_AREAS] : areas },
      {
        onSuccess: () => {
          toast.show('Access saved');
          onClose();
        },
      },
    );
  return (
    <Sheet
      open
      title={a.name}
      onClose={onClose}
      action={
        <Button
          variant="plain"
          disabled={owner}
          loading={save.isPending}
          style={{ fontWeight: 600 }}
          onClick={onSave}
        >
          Save
        </Button>
      }
    >
      <Section
        header="Start from"
        footer={
          owner ? 'The owner is always an admin.' : 'Then switch single areas on or off below.'
        }
      >
        <List label="Start from">
          {PRESETS.map((p) => (
            <li key={p}>
              <ButtonRow
                onClick={() => !owner && pick(p)}
                title={PRESET_LABEL[p]}
                meta={
                  preset === p ? (
                    <span className="team-cost" aria-label="Selected">
                      ✓
                    </span>
                  ) : undefined
                }
              />
            </li>
          ))}
        </List>
      </Section>
      <Section header="Can open" footer={isAdmin ? 'Admins see everything.' : undefined}>
        <List className="form-list" label="Can open">
          <li>
            <label className="row" style={{ cursor: owner ? 'default' : 'pointer' }}>
              <span className="row__main">Admin (manages access and rates)</span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={isAdmin}
                disabled={owner}
                onChange={(e) => setIsAdmin(e.target.checked)}
              />
            </label>
          </li>
          {ACCESS_AREAS.map((x) => (
            <li key={x}>
              <label className="row" style={{ cursor: isAdmin ? 'default' : 'pointer' }}>
                <span className="row__main">
                  <span className="row__title">{AREA_LABEL[x].title}</span>
                  <span className="row__sub">{AREA_LABEL[x].sub}</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={isAdmin || areas.includes(x)}
                  disabled={isAdmin}
                  onChange={(e) => toggle(x, e.target.checked)}
                />
              </label>
            </li>
          ))}
        </List>
      </Section>
      {save.error && (
        <p className="field-error" role="alert">
          {save.error.message}
        </p>
      )}
    </Sheet>
  );
}

function CostSheet({ m, onClose }: { m: TeamMemberDto; onClose: () => void }) {
  const [base, setBase] = useState(pounds(m.baseCostPence));
  const [mode, setMode] = useState<OnCostMode>(m.onCostMode ?? 'fixed');
  // Each mode keeps its own text, so switching back and forth never loses what was typed.
  const [onFixed, setOnFixed] = useState(pounds(m.onCostPence));
  const [onPct, setOnPct] = useState(m.onCostBp === null ? '' : formatPercentBp(m.onCostBp));
  const save = useSetMemberCost(m.userId);
  const saveRate = useSetChargeOut(m.userId);
  const toast = useToast();
  // Charge-out: their own rate, or empty for the business labour rate.
  const [chargeOut, setChargeOut] = useState(m.chargeOutIsDefault ? '' : pounds(m.chargeOutPence));
  const me = useMe();
  const businessRate =
    me.data?.tenant.labourRatePence ?? (m.chargeOutIsDefault ? m.chargeOutPence : null);
  const ownRate = chargeOut.trim() === '' ? null : parsePounds(chargeOut);
  const rateOk = chargeOut.trim() === '' || (ownRate !== null && ownRate >= 0);
  const effectiveRate = ownRate ?? businessRate ?? m.chargeOutPence;
  const rateChanged = (m.chargeOutIsDefault ? null : m.chargeOutPence) !== ownRate;
  const costEntered = base.trim() !== '';
  const b = parsePounds(base);
  const pct = onPct.trim() === '' ? 0 : parsePercentBp(onPct);
  const fixed = onFixed.trim() === '' ? 0 : parsePounds(onFixed);
  // The £/h the on-costs come to, rounded to the penny exactly as the server stores it.
  const o =
    mode === 'percent' ? (b !== null && pct !== null ? onCostFromPercent(b, pct) : null) : fixed;
  const ok = b !== null && b >= 0 && o !== null && o >= 0 && (mode === 'fixed' || pct !== null);
  const total = ok ? costRate(b, o) : null;
  const margin = total !== null ? effectiveRate - total : null;
  const canSave = rateOk && (ok || (!costEntered && rateChanged));
  const onSave = async () => {
    try {
      if (rateChanged) await saveRate.mutateAsync(ownRate);
      if (ok)
        await save.mutateAsync(
          mode === 'percent'
            ? { baseCostPence: b!, onCostMode: 'percent', onCostBp: pct! }
            : { baseCostPence: b!, onCostMode: 'fixed', onCostPence: o! },
        );
      toast.show('Rates saved');
      onClose();
    } catch {
      /* the error is shown in the sheet */
    }
  };
  const fields = save.error instanceof ApiError ? save.error.fields : {};
  return (
    <Sheet
      open
      title={m.name}
      onClose={onClose}
      action={
        <Button
          variant="plain"
          disabled={!canSave}
          loading={save.isPending || saveRate.isPending}
          style={{ fontWeight: 600 }}
          onClick={() => void onSave()}
        >
          Save
        </Button>
      }
    >
      <Section
        header="Cost per hour (£)"
        footer={
          m.isPlaceholder
            ? 'These are placeholder figures from the demo set-up. Replace them with the real cost.'
            : 'Only you see this. Changing it updates profit in Reports straight away.'
        }
      >
        <List className="form-list form-list--wide-labels">
          <TextField
            label="Charge-out rate"
            inputMode="decimal"
            value={chargeOut}
            onChange={(e) => setChargeOut(e.target.value)}
            placeholder={`${pounds(businessRate ?? m.chargeOutPence)} (default)`}
            error={
              !rateOk
                ? 'Enter an amount, e.g. 45.00'
                : saveRate.error instanceof ApiError
                  ? saveRate.error.message
                  : undefined
            }
          />
          <TextField
            label="Base cost"
            inputMode="decimal"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            error={b === null && base.trim() ? 'Enter an amount, e.g. 18.50' : fields.baseCostPence}
            data-autofocus
          />
          <li>
            <div className="row">
              <span className="field">
                <span className="field__label">Tax and on-costs as</span>
                <span className="field__seg">
                  <Segmented
                    label="Tax and on-costs as"
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: 'percent', label: '%' },
                      { value: 'fixed', label: '£/h' },
                    ]}
                  />
                </span>
              </span>
            </div>
          </li>
          {mode === 'percent' ? (
            <TextField
              label="Tax and on-costs (%)"
              inputMode="decimal"
              value={onPct}
              onChange={(e) => setOnPct(e.target.value)}
              placeholder="e.g. 22.5"
              error={
                pct === null ? 'A percentage up to 200, e.g. 22.5' : (fields.onCostBp ?? undefined)
              }
            />
          ) : (
            <TextField
              label="Tax and on-costs (£/h)"
              inputMode="decimal"
              value={onFixed}
              onChange={(e) => setOnFixed(e.target.value)}
              placeholder="e.g. 3.20"
              error={fixed === null ? 'Enter an amount, e.g. 3.20' : fields.onCostPence}
            />
          )}
          {mode === 'percent' && o !== null && b !== null && (
            <KeyValueRow label="On-costs per hour" value={`${formatPence(o)}/h`} />
          )}
          <KeyValueRow
            label="Total cost per hour"
            value={total === null ? '—' : `${formatPence(total)}/h`}
            strong
          />
          {margin !== null && (
            <KeyValueRow
              label="Left per hour charged"
              value={
                <span style={{ color: margin < 0 ? 'var(--red)' : undefined }}>
                  {margin < 0 ? '−' : ''}
                  {formatPence(Math.abs(margin))}
                </span>
              }
            />
          )}
        </List>
      </Section>
      {m.costRatePence !== null && (
        <div className="button-stack">
          <Button
            variant="plain"
            block
            onClick={() =>
              save.mutate(null, {
                onSuccess: () => {
                  toast.show('Cost rate cleared');
                  onClose();
                },
              })
            }
          >
            Clear Cost Rate
          </Button>
          <p className="sheet-hint">
            With no cost rate, their time is costed at the charge-out rate.
          </p>
        </div>
      )}
    </Sheet>
  );
}
