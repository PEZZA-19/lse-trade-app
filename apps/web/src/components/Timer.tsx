import { useEffect, useState } from 'react';
import { useRunningTimer, useTimer } from '../api/hooks';
import { formatElapsed } from '../lib/dates';
import { NeedsAttentionError } from '../offline';
import { IconPlay, IconStop } from './icons';
import { Sheet } from './Sheet';
import { useToast } from './Toast';
import { Button } from './ui';

/** Re-renders every second while a timer is shown. */
export function useElapsed(startedAt: string | null | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? formatElapsed(now - Date.parse(startedAt)) : null;
}

export function Elapsed(props: { startedAt: string }) {
  const text = useElapsed(props.startedAt);
  return (
    <span className="num timer-elapsed" role="timer" aria-label={`Timer running: ${text}`}>
      {text}
    </span>
  );
}

type JobRef = { id: string; number: string; title: string };

/**
 * Start / Stop for one job. If my timer is running on another job, asks before switching.
 * Works offline (queued with the real time; the toast says so).
 */
export function TimerButton(props: { job: JobRef; compact?: boolean }) {
  const running = useRunningTimer();
  const timer = useTimer();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const mine = running.data?.jobId === props.job.id;
  const elsewhere = running.data && !mine ? running.data : null;

  // mutateAsync, not mutate: the button may unmount when the timer stops (e.g. the Home card),
  // and the person must still be told what happened.
  const run = (action: 'start' | 'stop', switchTimer = false) =>
    timer.mutateAsync({ job: props.job, action, switch: switchTimer }).then(
      (r) => {
        const what = action === 'start' ? 'started' : 'stopped';
        toast.show(
          r === 'queued'
            ? `Timer ${what} on this device for job ${props.job.number}. It will sync when you’re back online.`
            : action === 'stop'
              ? `Timer stopped. Time added to job ${props.job.number}.`
              : `Timer started on job ${props.job.number}`,
        );
      },
      (e: Error) =>
        toast.show(
          e instanceof NeedsAttentionError ? e.message : `Timer not changed. ${e.message}`,
          { tone: 'error' },
        ),
    );

  return (
    <>
      {mine ? (
        <Button
          variant="destructive"
          block={!props.compact}
          onClick={() => void run('stop')}
          disabled={timer.isPending}
          aria-label={`Stop timer on job ${props.job.number}`}
        >
          <IconStop width={16} height={16} /> Stop
        </Button>
      ) : (
        <Button
          variant={props.compact ? 'secondary' : 'primary'}
          block={!props.compact}
          onClick={() => (elsewhere ? setConfirm(true) : void run('start'))}
          disabled={timer.isPending}
          aria-label={`Start timer on job ${props.job.number}`}
        >
          <IconPlay width={16} height={16} /> Start
        </Button>
      )}
      <Sheet open={confirm} title="Switch timer?" onClose={() => setConfirm(false)}>
        <p className="sheet__text">
          Your timer is running on job {elsewhere?.jobNumber} ({elsewhere?.jobTitle}). Switching
          stops it now and adds that time to job {elsewhere?.jobNumber}, then starts timing job{' '}
          {props.job.number}.
        </p>
        <Button
          block
          onClick={() => {
            setConfirm(false);
            void run('start', true);
          }}
        >
          Switch to job {props.job.number}
        </Button>
      </Sheet>
    </>
  );
}
