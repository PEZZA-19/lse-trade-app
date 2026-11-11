import type { EnquiryDto, ProposalDto } from '@lse/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, resetDemo } from './mockApi';

const get = <T>(p: string) => handle('GET', p, undefined) as Promise<T>;
const post = <T>(p: string, b?: unknown, h?: Record<string, string>) =>
  handle('POST', p, b, h) as Promise<T>;

describe('demo enquiries and approvals (mirror the server rules)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('seeds two enquiries to do, a drafted reply and a price update waiting', async () => {
    const todo = await get<EnquiryDto[]>('/enquiries?status=todo');
    expect(todo.map((e) => e.name)).toEqual(['Robin Demo', 'Harbour Café (demo)']);
    const open = await get<ProposalDto[]>('/proposals');
    expect(open.map((p) => [p.kind, p.status, p.drafter])).toEqual([
      ['reply_email', 'pending', 'fake'],
      ['price_update', 'pending', null],
    ]);
    expect(await get('/proposals/counts')).toEqual({ pending: 2, held: 0 });
  });

  it('approve holds the email two minutes; Stop puts it back; nothing is ever sent', async () => {
    const [reply] = await get<ProposalDto[]>('/proposals');
    const held = await post<ProposalDto>(
      `/proposals/${reply!.id}/approve`,
      {},
      { 'if-match': String(reply!.version) },
    );
    expect(held.status).toBe('held');
    expect(new Date(held.holdUntil!).getTime() - Date.now()).toBeGreaterThan(110_000);
    const back = await post<ProposalDto>(`/proposals/${reply!.id}/stop`);
    expect(back.status).toBe('pending');
    await post(`/proposals/${reply!.id}/approve`);
    // Time passes: with no email account connected it ends "not sent".
    const raw = JSON.parse(localStorage.getItem('lse-demo-db-v6')!);
    raw.inbox.proposals[0].holdUntil = new Date(Date.now() - 1000).toISOString();
    localStorage.setItem('lse-demo-db-v6', JSON.stringify(raw));
    resetDemoKeep();
    const after = await get<ProposalDto>(`/proposals/${reply!.id}`);
    expect(after.status).toBe('send_blocked');
    expect(after.events!.map((e) => e.event)).toEqual([
      'created',
      'approved',
      'stopped',
      'approved',
      'send_blocked',
    ]);
  });

  it('a quote draft becomes a draft quote and converts the enquiry; price update applies the bill', async () => {
    const harbour = (await get<EnquiryDto[]>('/enquiries')).find((e) =>
      e.name.startsWith('Harbour'),
    )!;
    const d = await post<ProposalDto>(`/enquiries/${harbour.id}/draft-quote`);
    expect(d.kind).toBe('quote_draft');
    const done = await post<ProposalDto>(`/proposals/${d.id}/approve`);
    expect(done.status).toBe('applied');
    const e = await get<EnquiryDto>(`/enquiries/${harbour.id}`);
    expect(e).toMatchObject({ status: 'converted', convertedTo: 'quote' });
    const prices = (await get<ProposalDto[]>('/proposals')).find((p) => p.kind === 'price_update')!;
    const applied = await post<ProposalDto>(`/proposals/${prices.id}/approve`);
    expect(applied.status).toBe('applied');
  });

  it('converts to a job with an appointment, and rejects with a reason', async () => {
    const [robin, harbour] = await get<EnquiryDto[]>('/enquiries');
    const r = await post<EnquiryDto>(`/enquiries/${robin!.id}/convert`, {
      to: 'appointment',
      startsAt: '2026-11-20T09:00:00Z',
      endsAt: '2026-11-20T10:00:00Z',
    });
    expect(r).toMatchObject({
      status: 'converted',
      convertedTo: 'appointment',
      customerName: 'Robin Demo',
    });
    const x = await post<EnquiryDto>(`/enquiries/${harbour!.id}/reject`, { reason: 'Too far' });
    expect(x).toMatchObject({ status: 'rejected', rejectReason: 'Too far' });
    expect(await get('/enquiries/counts')).toEqual({ todo: 0 });
  });
});

/** Reload the demo database from storage, as a page reload would. */
function resetDemoKeep() {
  const saved = localStorage.getItem('lse-demo-db-v6');
  resetDemo();
  if (saved) localStorage.setItem('lse-demo-db-v6', saved);
}
