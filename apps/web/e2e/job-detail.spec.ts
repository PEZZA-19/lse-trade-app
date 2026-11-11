import { expect, test } from '@playwright/test';

// A tiny synthetic PNG (a 1x1 pixel); the app resizes and re-encodes it as JPEG on the device.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('job detail: log, edit and delete time by hand; add, edit and remove a material; notes; photos', async ({
  page,
}) => {
  await page.goto('/jobs');
  await page.getByRole('searchbox').fill('Barn rewire');
  await page.getByText('Barn rewire and LED lighting').click();
  await expect(page.getByRole('heading', { name: /Job 122/ })).toBeVisible();

  // Time by hand.
  const time = page.getByRole('list', { name: 'Timesheet entries' });
  await time.getByRole('button', { name: 'Log Time…' }).click();
  let sheet = page.getByRole('dialog', { name: 'Log Time' });
  await sheet.getByLabel('Date').fill(daysAgo(12));
  await sheet.getByLabel('Start').fill('06:00');
  await sheet.getByLabel('End').fill('07:30');
  await expect(sheet.getByText('1 h 30 min')).toBeVisible();
  await sheet.getByLabel('Note').fill('E2E forgot the timer');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  const entry = time.getByRole('button', { name: /E2E forgot the timer/ });
  await expect(entry).toContainText('by hand');
  await expect(entry).toContainText('1 h 30 min');

  await entry.click();
  sheet = page.getByRole('dialog', { name: 'Edit Time' });
  await sheet.getByLabel('End').fill('07:00');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(time.getByRole('button', { name: /E2E forgot the timer/ })).toContainText('1 h');
  await expect(time.getByRole('button', { name: /E2E forgot the timer/ })).not.toContainText(
    '30 min',
  );

  // Overlap is refused with a clear message.
  await time.getByRole('button', { name: 'Log Time…' }).click();
  sheet = page.getByRole('dialog', { name: 'Log Time' });
  await sheet.getByLabel('Date').fill(daysAgo(12));
  await sheet.getByLabel('Start').fill('06:30');
  await sheet.getByLabel('End').fill('08:00');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByText(/overlaps time already logged on job 122/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();

  await time.getByRole('button', { name: /E2E forgot the timer/ }).click();
  sheet = page.getByRole('dialog', { name: 'Edit Time' });
  await sheet.getByRole('button', { name: 'Delete Time' }).click();
  await page
    .getByRole('dialog', { name: 'Delete Time' })
    .getByRole('button', { name: 'Delete Time' })
    .click();
  await expect(time.getByRole('button', { name: /E2E forgot the timer/ })).toHaveCount(0);

  // Material by hand: price follows cost × markup until typed over.
  const mats = page.getByRole('list', { name: 'Materials and extras' });
  await mats.getByRole('button', { name: 'Add Material…' }).click();
  sheet = page.getByRole('dialog', { name: 'Add Material' });
  await sheet.getByLabel('Item').fill('E2E RCBO from the counter');
  await sheet.getByLabel('Quantity').fill('2');
  await sheet.getByLabel('Cost each (£)').fill('10.00');
  await expect(sheet.getByText('£26.00')).toBeVisible();
  await sheet.getByRole('button', { name: 'Add' }).click();
  const line = mats.getByRole('button', { name: /E2E RCBO/ });
  await expect(line).toContainText('£26.00');
  await line.click();
  sheet = page.getByRole('dialog', { name: 'Edit Line' });
  await sheet.getByLabel('Price each (£)').fill('15.00');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(mats.getByRole('button', { name: /E2E RCBO/ })).toContainText('£30.00');
  await mats.getByRole('button', { name: /E2E RCBO/ }).click();
  await page
    .getByRole('dialog', { name: 'Edit Line' })
    .getByRole('button', { name: 'Delete Line' })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete Line' })
    .getByRole('button', { name: 'Delete Line' })
    .click();
  await expect(mats.getByRole('button', { name: /E2E RCBO/ })).toHaveCount(0);

  // Notes.
  const notes = page.getByRole('list', { name: 'Job notes' });
  await notes.getByRole('button', { name: 'Add Note…' }).click();
  sheet = page.getByRole('dialog', { name: 'Add Note' });
  await sheet.getByLabel('Note').fill('E2E isolator is in the shed');
  await sheet.getByRole('button', { name: 'Add' }).click();
  await expect(notes).toContainText('E2E isolator is in the shed');
  await notes.getByRole('button', { name: /E2E isolator/ }).click();
  await page
    .getByRole('dialog', { name: 'Note' })
    .getByRole('button', { name: 'Delete Note' })
    .click();
  await expect(notes).not.toContainText('E2E isolator');

  // Photos: resized on the device, uploaded, shown, deleted.
  await page
    .getByTestId('photo-input')
    .setInputFiles({ name: 'cu.png', mimeType: 'image/png', buffer: PNG });
  sheet = page.getByRole('dialog', { name: 'Add Photo' });
  await expect(sheet.getByText('1 × 1')).toBeVisible();
  await sheet.getByLabel('Caption').fill('E2E consumer unit');
  await sheet.getByRole('button', { name: 'Upload' }).click();
  const grid = page.getByRole('list', { name: 'Job photos' });
  await expect(grid.getByRole('button', { name: 'E2E consumer unit' })).toBeVisible();
  await expect
    .poll(() =>
      grid
        .locator('img')
        .first()
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBe(1);
  await grid.getByRole('button', { name: 'E2E consumer unit' }).click();
  sheet = page.getByRole('dialog', { name: 'E2E consumer unit' });
  await sheet.getByRole('button', { name: 'Delete Photo…' }).click();
  await sheet.getByRole('button', { name: 'Delete Photo for Everyone' }).click();
  await expect(grid).toHaveCount(0);
});
