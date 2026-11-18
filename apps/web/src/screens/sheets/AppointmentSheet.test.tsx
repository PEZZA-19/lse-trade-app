import type { JobSummaryDto } from '@lse/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppointmentSheet } from './AppointmentSheet';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  move: vi.fn(),
  remove: vi.fn(),
  retry: vi.fn(),
  toast: vi.fn(),
  jobs: [] as JobSummaryDto[],
  loading: false,
  loadError: false,
  error: null as Error | null,
}));
vi.mock('../../api/hooks', () => ({
  useSession: () => ({ data: { user: { id: 'owner' } } }),
  useMembers: () => ({ data: [{ userId: 'owner', name: 'Demo Owner' }] }),
  useJobs: () => ({
    data: { items: mocks.jobs },
    isPending: mocks.loading,
    isError: mocks.loadError,
    refetch: mocks.retry,
  }),
  useCreateAppointment: () => ({ mutate: mocks.create, isPending: false, error: mocks.error }),
  useMoveAppointment: () => ({ mutate: mocks.move, isPending: false }),
  useDeleteAppointment: () => ({ mutate: mocks.remove, isPending: false }),
}));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ show: mocks.toast }) }));

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>New appointment</button>
      <AppointmentSheet
        state={open ? { mode: 'create', start: new Date('2026-11-18T09:00:00') } : null}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jobs = Array.from(
    { length: 30 },
    (_, i) =>
      ({
        id: `job-${i}`,
        number: `${100 + i}`,
        title: i === 29 ? 'Long job title '.repeat(25) : `Demo job ${i}`,
      }) as JobSummaryDto,
  );
  mocks.loading = false;
  mocks.loadError = false;
  mocks.error = null;
});
afterEach(cleanup);

async function openPicker() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'New appointment' }));
  await user.click(screen.getByRole('button', { name: 'Job Choose a job…' }));
  return user;
}

describe('Schedule appointment job picker', () => {
  it('keeps choices inside the dialog, supports keyboard navigation and only writes on Book', async () => {
    const user = await openPicker();
    const list = screen.getByRole('listbox', { name: 'Job' });
    expect(screen.getByRole('dialog', { name: 'New appointment' })).toContainElement(list);
    expect(list).toHaveFocus();
    expect(screen.getAllByRole('option')).toHaveLength(30);
    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();
    await user.keyboard('{End}{ArrowUp}{Home}{ArrowDown}{Enter}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Job 101 · Demo job 1' })).toHaveFocus();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Book' }));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ jobId: 'job-1', userId: 'owner' });
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // Not saved until success.
    const success = mocks.create.mock.calls[0]![1].onSuccess;
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(success).toBeTypeOf('function');
  });

  it('Escape closes the picker first, then the sheet, and restores launcher focus', async () => {
    const user = await openPicker();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Job Choose a job…' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New appointment' })).toHaveFocus();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('Tab and Shift+Tab leave the list naturally; typeahead and touch/click can select', async () => {
    const user = await openPicker();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Job Choose a job…' })).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    await user.tab();
    expect(screen.getByLabelText('Date')).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Job Choose a job…' }));
    await user.keyboard('129{Enter}');
    expect(screen.getByRole('button', { name: /Job 129 · Long job title/ })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: /Job 129/ }));
    expect(screen.getAllByRole('option')[29]).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: '100 · Demo job 0' }));
    expect(screen.getByRole('button', { name: 'Job 100 · Demo job 0' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'New appointment' }));
    expect(screen.getByRole('button', { name: 'Job Choose a job…' })).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('shows loading, empty and failed reads with Retry, without saving', async () => {
    mocks.jobs = [];
    mocks.loading = true;
    const user = await openPicker();
    expect(screen.getByRole('status')).toHaveTextContent('Loading jobs…');
    mocks.loading = false;
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Job Choose a job…' }));
    expect(screen.getByRole('status')).toHaveTextContent('No active jobs to book.');
    mocks.loadError = true;
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Job Choose a job…' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Jobs could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps a failed booking visible and preserves booking from a job without a picker', async () => {
    mocks.error = new Error('No connection. Nothing was saved.');
    const user = await openPicker();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Book' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No connection. Nothing was saved.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    cleanup();
    render(
      <AppointmentSheet
        state={{
          mode: 'create',
          jobId: 'job-2',
          jobLabel: 'job 102',
          start: new Date('2026-11-18T09:00:00'),
        }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Choose a job/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(mocks.create.mock.calls[1]![0]).toMatchObject({ jobId: 'job-2' }));
  });
});
