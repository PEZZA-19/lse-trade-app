import { describe, expect, it } from 'vitest';
import { autoStage, canRenameStage, jobStageCreate } from '../src/stages';

const none = { hasAssignees: false, appointmentsLeft: 0 };

describe('autoStage', () => {
  it('assigning moves Unassigned to Assigned only', () => {
    expect(autoStage('assigned', 'unassigned')).toBe('assigned');
    for (const s of ['assigned', 'scheduled', 'in_progress', 'on_hold', 'to_invoice'] as const)
      expect(autoStage('assigned', s)).toBeNull();
    expect(autoStage('assigned', null)).toBeNull();
  });
  it('an appointment books in Unassigned or Assigned jobs', () => {
    expect(autoStage('appointment_created', 'unassigned')).toBe('scheduled');
    expect(autoStage('appointment_created', 'assigned')).toBe('scheduled');
    expect(autoStage('appointment_created', 'in_progress')).toBeNull();
    expect(autoStage('appointment_created', 'on_hold')).toBeNull();
  });
  it('deleting the last appointment steps back from Booked in', () => {
    expect(autoStage('appointment_deleted', 'scheduled', none)).toBe('unassigned');
    expect(
      autoStage('appointment_deleted', 'scheduled', { hasAssignees: true, appointmentsLeft: 0 }),
    ).toBe('assigned');
    expect(
      autoStage('appointment_deleted', 'scheduled', { hasAssignees: true, appointmentsLeft: 1 }),
    ).toBeNull();
    expect(autoStage('appointment_deleted', 'in_progress', none)).toBeNull();
  });
  it('removing the last person steps Assigned back to Unassigned, nothing else', () => {
    expect(autoStage('last_unassigned', 'assigned', none)).toBe('unassigned');
    expect(autoStage('last_unassigned', 'assigned', { ...none, hasAssignees: true })).toBeNull();
    for (const s of ['unassigned', 'scheduled', 'in_progress', 'on_hold', 'complete'] as const)
      expect(autoStage('last_unassigned', s, none)).toBeNull();
    expect(autoStage('last_unassigned', null, none)).toBeNull(); // custom stage: stays put
  });
  it('custom stages: only the timer and payment move a job out of one', () => {
    expect(autoStage('assigned', null)).toBeNull();
    expect(autoStage('appointment_created', null)).toBeNull();
    expect(autoStage('appointment_deleted', null, none)).toBeNull();
    expect(autoStage('timer_started', null)).toBe('in_progress');
    expect(autoStage('invoiced_and_paid', null)).toBe('complete');
  });
  it('every event on every system stage gives a known stage or null', () => {
    const stages = [
      'unassigned',
      'assigned',
      'scheduled',
      'in_progress',
      'on_hold',
      'to_invoice',
      'complete',
      'cancelled',
    ] as const;
    const events = [
      'assigned',
      'last_unassigned',
      'appointment_created',
      'appointment_deleted',
      'timer_started',
      'invoiced_and_paid',
    ] as const;
    for (const st of stages)
      for (const e of events) {
        const next = autoStage(e, st, none);
        expect(next === null || stages.includes(next)).toBe(true);
        // Nothing automatic ever moves a cancelled job.
        if (st === 'cancelled') expect(next).toBeNull();
      }
  });
  it('starting the timer moves to In Progress unless finished', () => {
    for (const s of ['unassigned', 'assigned', 'scheduled', 'to_invoice', 'on_hold', null] as const)
      expect(autoStage('timer_started', s)).toBe('in_progress');
    for (const s of ['in_progress', 'complete', 'cancelled'] as const)
      expect(autoStage('timer_started', s)).toBeNull();
  });
  it('fully invoiced and paid completes the job unless cancelled', () => {
    expect(autoStage('invoiced_and_paid', 'to_invoice')).toBe('complete');
    expect(autoStage('invoiced_and_paid', 'cancelled')).toBeNull();
    expect(autoStage('invoiced_and_paid', 'complete')).toBeNull();
  });
});

describe('stage rules', () => {
  it('only To Invoice, On Hold and custom stages can be renamed', () => {
    expect(canRenameStage('to_invoice')).toBe(true);
    expect(canRenameStage('on_hold')).toBe(true);
    expect(canRenameStage(null)).toBe(true);
    expect(canRenameStage('scheduled')).toBe(false);
    expect(canRenameStage('complete')).toBe(false);
  });
  it('validates custom stages', () => {
    expect(jobStageCreate.safeParse({ name: 'Waiting on parts', colour: 'teal' }).success).toBe(
      true,
    );
    expect(jobStageCreate.safeParse({ name: '', colour: 'teal' }).success).toBe(false);
    expect(jobStageCreate.safeParse({ name: 'X', colour: 'magenta' }).success).toBe(false);
  });
});
