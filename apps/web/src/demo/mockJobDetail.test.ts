import type { JobDetailDto, JobNoteDto, JobPhotoDto } from '@lse/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, resetDemo } from './mockApi';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function barn() {
  const jobs = (await handle('GET', '/jobs', undefined)) as {
    items: { id: string; number: string }[];
  };
  return jobs.items.find((j) => j.number === '122')!;
}

describe('demo job detail (mirrors the server rules)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDemo();
  });

  it('time by hand: add, overlap refused, edit, delete', async () => {
    const j = await barn();
    const before = (await handle('GET', `/jobs/${j.id}`, undefined)) as JobDetailDto;
    const added = (await handle('POST', `/jobs/${j.id}/timesheets`, {
      startedAt: ago(20 * 24 * 60),
      endedAt: ago(20 * 24 * 60 - 90),
    })) as JobDetailDto;
    expect(added.totalMinutes).toBe(before.totalMinutes + 90);
    const sheet = added.timesheets.find((t) => t.source === 'manual')!;
    await expect(
      handle('POST', `/jobs/${j.id}/timesheets`, {
        startedAt: ago(20 * 24 * 60 - 30),
        endedAt: ago(20 * 24 * 60 - 120),
      }),
    ).rejects.toThrow(/overlaps time already logged on job 122/);
    const edited = (await handle('PATCH', `/timesheets/${sheet.id}`, {
      endedAt: ago(20 * 24 * 60 - 60),
    })) as JobDetailDto;
    expect(edited.totalMinutes).toBe(before.totalMinutes + 60);
    const gone = (await handle('DELETE', `/timesheets/${sheet.id}`, undefined)) as JobDetailDto;
    expect(gone.totalMinutes).toBe(before.totalMinutes);
  });

  it('materials, notes and photos', async () => {
    const j = await barn();
    const d = (await handle('POST', `/jobs/${j.id}/lines`, {
      description: 'RCBO',
      qtyMilli: 2000,
      unitCostPence: 1000,
    })) as JobDetailDto;
    const line = d.lines.find((l) => l.description === 'RCBO')!;
    expect(line).toMatchObject({ unitSellPence: 1300, totalPence: 2600, source: 'manual' });
    const quoteLine = d.lines.find((l) => l.source === 'quote')!;
    await expect(handle('DELETE', `/job-lines/${quoteLine.id}`, undefined)).rejects.toThrow(
      /quote revision/,
    );

    const notes = (await handle('POST', `/jobs/${j.id}/notes`, {
      body: 'Key in the van',
    })) as JobNoteDto[];
    expect(notes[0]).toMatchObject({ body: 'Key in the van', userName: 'Joe' });

    const photos = (await handle('POST', `/jobs/${j.id}/photos`, {
      dataUrl: PNG,
      caption: 'Before',
    })) as JobPhotoDto[];
    expect(photos[0]).toMatchObject({ caption: 'Before', url: PNG });
    expect(await handle('DELETE', `/photos/${photos[0]!.id}`, undefined)).toEqual([]);
  });
});
