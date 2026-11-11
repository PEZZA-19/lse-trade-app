import { costRate, formatPence, parsePounds, type TeamMemberDto } from '@lse/shared';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useSetMemberCost, useTeam } from '../api/team';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { Button, ButtonRow, KeyValueRow, List, Pill, Section, TextField } from '../components/ui';

const ROLE: Record<string, string> = {
  owner: 'Owner',
  staff: 'Staff',
  subcontractor: 'Subcontractor',
  accountant: 'Accountant',
};
const pounds = (p: number | null) => (p === null ? '' : formatPence(p).replace('£', ''));

/**
 * Settings › Team (owner only): each person's charge-out rate beside what they really cost per
 * hour (base + tax/on-costs). Reports and job costs use the cost rate for true profit.
 */
export function TeamSection() {
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
            <ButtonRow
              onClick={() => setEditing(m)}
              chevron
              title={
                <>
                  {m.name} {m.isPlaceholder && <Pill tone="orange">Placeholder</Pill>}
                </>
              }
              sub={`${ROLE[m.role] ?? m.role} · charge-out ${formatPence(m.chargeOutPence)}/h`}
              meta={
                m.costRatePence === null ? (
                  <span className="team-cost team-cost--unset">Cost not set</span>
                ) : (
                  <span className="team-cost">{formatPence(m.costRatePence)}/h cost</span>
                )
              }
            />
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

function CostSheet({ m, onClose }: { m: TeamMemberDto; onClose: () => void }) {
  const [base, setBase] = useState(pounds(m.baseCostPence));
  const [on, setOn] = useState(pounds(m.onCostPence));
  const save = useSetMemberCost(m.userId);
  const toast = useToast();
  const b = parsePounds(base);
  const o = on.trim() === '' ? 0 : parsePounds(on);
  const ok = b !== null && b >= 0 && o !== null && o >= 0;
  const total = ok ? costRate(b, o) : null;
  const margin = total !== null ? m.chargeOutPence - total : null;
  const fields = save.error instanceof ApiError ? save.error.fields : {};
  return (
    <Sheet
      open
      title={m.name}
      onClose={onClose}
      action={
        <Button
          variant="plain"
          disabled={!ok}
          loading={save.isPending}
          style={{ fontWeight: 600 }}
          onClick={() =>
            save.mutate(
              { baseCostPence: b!, onCostPence: o! },
              {
                onSuccess: () => {
                  toast.show('Cost rate saved');
                  onClose();
                },
              },
            )
          }
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
          <KeyValueRow label="Charge-out rate" value={`${formatPence(m.chargeOutPence)}/h`} />
          <TextField
            label="Base cost"
            inputMode="decimal"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            error={b === null && base.trim() ? 'Enter an amount, e.g. 18.50' : fields.baseCostPence}
            data-autofocus
          />
          <TextField
            label="Tax and on-costs"
            inputMode="decimal"
            value={on}
            onChange={(e) => setOn(e.target.value)}
            error={o === null ? 'Enter an amount, e.g. 3.20' : fields.onCostPence}
          />
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
