import { describe, expect, it } from 'vitest';
import { client, seedCustomer, type Client } from './api-helpers';

const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function job(c: Client, title = 'Kitchen sockets') {
  const cust = await seedCustomer(c);
  return (await c.req('POST', '/api/jobs', { customerId: cust.id, title })).body;
}

describe('job detail edge cases', () => {
  it('touching entries are fine; time over a running timer is refused until it stops', async () => {
    const c = await client();
    const j = await job(c);
    const k = await job(c, 'Outside light');

    // End of one = start of the next: not an overlap, even across jobs.
    const t1 = at(200);
    const t2 = at(180);
    const t3 = at(160);
    expect(
      (await c.req('POST', `/api/jobs/${j.id}/timesheets`, { startedAt: t1, endedAt: t2 })).status,
    ).toBe(201);
    expect(
      (await c.req('POST', `/api/jobs/${k.id}/timesheets`, { startedAt: t2, endedAt: t3 })).status,
    ).toBe(201);
    // Overlap across jobs names the other job.
    const cross = await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
      startedAt: at(170),
      endedAt: at(150),
    });
    expect(cross.status).toBe(422);
    expect(cross.body.error.message).toContain(`job ${k.number}`);

    expect((await c.req('POST', `/api/jobs/${k.id}/timer/start`)).status).toBe(200);
    const overTimer = await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
      startedAt: at(5),
      endedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(overTimer.status).toBe(422);
    expect(overTimer.body.error.message).toMatch(
      new RegExp(`timer still running on job ${k.number}`),
    );
    // Before the timer started is fine.
    expect(
      (await c.req('POST', `/api/jobs/${j.id}/timesheets`, { startedAt: at(60), endedAt: at(30) }))
        .status,
    ).toBe(201);
    expect((await c.req('POST', `/api/jobs/${k.id}/timer/stop`)).status).toBe(200);
  });

  it('edits are checked like new entries: overlap, future, over 16 h, end before start', async () => {
    const c = await client();
    const j = await job(c);
    await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
      startedAt: at(300),
      endedAt: at(240),
      note: 'A',
    });
    const r = await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
      startedAt: at(120),
      endedAt: at(60),
      note: 'B',
    });
    const b = r.body.timesheets.find((t: { note: string }) => t.note === 'B');

    const edit = (body: object) => c.req('PATCH', `/api/timesheets/${b.id}`, body);
    expect((await edit({ startedAt: at(250) })).status).toBe(422); // runs into A
    expect((await edit({ endedAt: new Date(Date.now() + 60 * 60_000).toISOString() })).status).toBe(
      422,
    );
    expect((await edit({ startedAt: at(60 + 17 * 60) })).status).toBe(422);
    expect((await edit({ startedAt: at(30) })).status).toBe(422); // after its own end
    // Moving it to touch A exactly is fine; the note is kept when not sent.
    const ok = await edit({ startedAt: at(240) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.timesheets.find((t: { id: string }) => t.id === b.id).note).toBe('B');
    expect(ok.body.totalMinutes).toBe(60 + 180);
  });

  it('another business cannot see or change this job’s time, lines, notes or photos', async () => {
    const c = await client();
    const other = await client();
    const j = await job(c);
    const withTime = await c.req('POST', `/api/jobs/${j.id}/timesheets`, {
      startedAt: at(90),
      endedAt: at(30),
    });
    const sheet = withTime.body.timesheets[0];
    const line = (
      await c.req('POST', `/api/jobs/${j.id}/lines`, {
        description: 'Twin and earth 2.5mm',
        unitCostPence: 100,
      })
    ).body.lines.at(-1);
    const note = (await c.req('POST', `/api/jobs/${j.id}/notes`, { body: 'Key under the mat' }))
      .body;

    const tries = [
      other.req('POST', `/api/jobs/${j.id}/timesheets`, { startedAt: at(20), endedAt: at(10) }),
      other.req('PATCH', `/api/timesheets/${sheet.id}`, { note: 'x' }),
      other.req('DELETE', `/api/timesheets/${sheet.id}`),
      other.req('POST', `/api/jobs/${j.id}/lines`, { description: 'x', unitCostPence: 1 }),
      other.req('PATCH', `/api/job-lines/${line.id}`, { description: 'x' }),
      other.req('DELETE', `/api/job-lines/${line.id}`),
      other.req('GET', `/api/jobs/${j.id}/notes`),
      other.req('POST', `/api/jobs/${j.id}/notes`, { body: 'x' }),
      other.req('DELETE', `/api/notes/${note.id ?? note[0]?.id}`),
      other.req('GET', `/api/jobs/${j.id}/photos`),
    ];
    for (const res of await Promise.all(tries))
      expect([403, 404], JSON.stringify(res.body)).toContain(res.status);

    // Still all there for the owner.
    const after = (await c.req('GET', `/api/jobs/${j.id}`)).body;
    expect(after.totalMinutes).toBe(60);
    expect(
      after.lines.some((l: { description: string }) => l.description === 'Twin and earth 2.5mm'),
    ).toBe(true);
    expect((await c.req('GET', `/api/jobs/${j.id}/notes`)).body).toHaveLength(1);
  });

  it('material lines: zero or negative quantity and negative prices are refused', async () => {
    const c = await client();
    const j = await job(c);
    for (const bad of [
      { description: 'x', qtyMilli: 0 },
      { description: 'x', qtyMilli: -1000 },
      { description: 'x', unitCostPence: -1 },
      { description: '   ' },
    ])
      expect((await c.req('POST', `/api/jobs/${j.id}/lines`, bad)).status).toBe(422);
  });
});
