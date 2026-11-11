import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken, SIGNED_OUT_EVENT } from './client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
  setCsrfToken(null);
});

describe('api client', () => {
  it('sends the CSRF token on changes, not on reads', async () => {
    setCsrfToken('tok');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, {}));
    await api('GET', '/jobs');
    await api('POST', '/jobs', { a: 1 });
    const h = (i: number) =>
      (fetchMock.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;
    expect(h(0)['x-csrf-token']).toBeUndefined();
    expect(h(1)['x-csrf-token']).toBe('tok');
  });

  it('refreshes a stale CSRF token once and retries', async () => {
    setCsrfToken('old');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(403, { error: { code: 'csrf', message: 'refresh' } }))
      .mockResolvedValueOnce(json(200, { csrfToken: 'new' }))
      .mockResolvedValueOnce(json(201, { id: 'x' }));
    await expect(api('POST', '/customers', { name: 'A' })).resolves.toEqual({ id: 'x' });
    const last = fetchMock.mock.calls[2]![1] as RequestInit;
    expect((last.headers as Record<string, string>)['x-csrf-token']).toBe('new');
  });

  it('announces sign-out on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(401, { error: { code: 'unauthenticated', message: 'Please sign in' } }),
    );
    const seen = vi.fn();
    window.addEventListener(SIGNED_OUT_EVENT, seen);
    await expect(api('GET', '/jobs')).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveBeenCalledOnce();
    window.removeEventListener(SIGNED_OUT_EVENT, seen);
  });

  it('a network failure says nothing was saved', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api('POST', '/jobs', {})).rejects.toMatchObject({
      message: 'No connection. Nothing was saved.',
    });
  });
});
