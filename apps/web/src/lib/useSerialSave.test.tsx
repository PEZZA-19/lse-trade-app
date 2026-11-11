import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSerialSave } from './useSerialSave';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useSerialSave', () => {
  it('sends one save at a time and always finishes with the latest edit', async () => {
    const calls: number[] = [];
    const pending: ReturnType<typeof deferred>[] = [];
    const { result } = renderHook(() =>
      useSerialSave<number>((n) => {
        calls.push(n);
        const d = deferred();
        pending.push(d);
        return d.promise;
      }),
    );
    act(() => result.current.save(1));
    act(() => result.current.save(2));
    act(() => result.current.save(3));
    expect(calls).toEqual([1]); // 2 is superseded by 3 while 1 is in flight
    expect(result.current.state).toBe('saving');
    await act(async () => pending[0]!.resolve());
    expect(calls).toEqual([1, 3]);
    expect(result.current.state).toBe('saving'); // never "saved" while a write is outstanding
    await act(async () => pending[1]!.resolve());
    expect(result.current.state).toBe('saved');
  });

  it('keeps a failure visible and retries the failed edit', async () => {
    let fail = true;
    const calls: number[] = [];
    const { result } = renderHook(() =>
      useSerialSave<number>(async (n) => {
        calls.push(n);
        if (fail) throw new Error('No connection. Nothing was saved.');
      }),
    );
    await act(async () => result.current.save(7));
    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/Nothing was saved/);
    fail = false;
    await act(async () => result.current.retry());
    expect(calls).toEqual([7, 7]);
    expect(result.current.state).toBe('saved');
  });

  it('says "saved on this device" (not "saved") when the edit is only queued locally', async () => {
    const { result } = renderHook(() => useSerialSave<number>(async () => 'queued'));
    await act(async () => result.current.save(1));
    expect(result.current.state).toBe('queued');
  });
});
