import { useAssign, useMembers } from '../../api/hooks';
import { IconCheck } from '../../components/icons';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { ButtonRow, List, ListSkeleton } from '../../components/ui';
import { initials } from '../../lib/status';

/** Tick people to assign them to the job; untick to remove. */
export function AssignSheet(props: {
  open: boolean;
  job: { id: string; number: string; assignees: { userId: string }[] };
  onClose: () => void;
}) {
  const members = useMembers();
  const assign = useAssign();
  const toast = useToast();
  const assigned = new Set(props.job.assignees.map((a) => a.userId));
  return (
    <Sheet open={props.open} title="Assign" onClose={props.onClose} cancelLabel="Done">
      {members.isPending ? (
        <ListSkeleton rows={2} />
      ) : (
        <List label="People">
          {(members.data ?? []).map((m) => {
            const on = assigned.has(m.userId);
            return (
              <li key={m.userId}>
                <ButtonRow
                  onClick={() =>
                    assign.mutate(
                      { jobId: props.job.id, userId: m.userId, remove: on },
                      {
                        onSuccess: (j) =>
                          toast.show(
                            on
                              ? `${m.name} removed from job ${j.number}`
                              : `${m.name} assigned to job ${j.number}` +
                                  (j.stage.systemKey === 'assigned' ? ' · Assigned' : ''),
                          ),
                        onError: (e) => toast.show(`Not changed. ${e.message}`, { tone: 'error' }),
                      },
                    )
                  }
                  lead={
                    <span className="avatar" aria-hidden>
                      {initials(m.name)}
                    </span>
                  }
                  title={m.name}
                  sub={m.role === 'owner' ? 'Owner' : m.role === 'staff' ? 'Staff' : m.role}
                  meta={on ? <IconCheck width={20} height={20} aria-label="Assigned" /> : undefined}
                />
              </li>
            );
          })}
        </List>
      )}
    </Sheet>
  );
}
