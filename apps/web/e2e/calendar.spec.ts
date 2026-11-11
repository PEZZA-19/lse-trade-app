import { expect, test } from '@playwright/test';
import path from 'node:path';

const SHOTS = path.resolve(import.meta.dirname, '../../../screenshots');
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('More › Calendar: private link, subscribe links, copy, regenerate (old link 404), switch off', async ({
  page,
}) => {
  await page.goto('/more');
  await page.getByRole('link', { name: /Calendar/ }).click();
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
  // Owner: their own jobs and (as admin) all jobs.
  await expect(page.getByText('Your jobs', { exact: true })).toBeVisible();
  await expect(page.getByText('All jobs', { exact: true })).toBeVisible();

  const mine = page.getByRole('list', { name: 'Your jobs calendar link' });
  if (!(await mine.isVisible())) {
    await page.getByRole('button', { name: 'Create Calendar Link' }).first().click();
  }
  const code = mine.getByLabel('Your jobs link');
  await expect(code).toHaveText(/\/api\/public\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
  const first = (await code.textContent())!;

  // The feed is real iCal and needs no sign-in.
  const anon = await page.context().request.fetch(first, { headers: { cookie: '' } });
  expect(anon.status()).toBe(200);
  expect(anon.headers()['content-type']).toBe('text/calendar; charset=utf-8');
  const body = await anon.text();
  expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
  expect(body).not.toMatch(/£/);

  await expect(page.getByRole('link', { name: 'Add to Google Calendar' }).first()).toHaveAttribute(
    'href',
    /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2F/,
  );
  await expect(page.getByRole('link', { name: 'Add to Outlook' }).first()).toHaveAttribute(
    'href',
    /^https:\/\/outlook\.live\.com\/calendar\/0\/addfromweb\?url=http/,
  );
  await expect(page.getByRole('link', { name: 'Open in Calendar App' }).first()).toHaveAttribute(
    'href',
    /^webcal:\/\//,
  );
  await expect(page.getByText(/within a few hours/).first()).toBeVisible();
  if (process.env.CAPTURE === '1') {
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/mobile-${scheme}-61-calendar.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }

  await page.getByRole('button', { name: 'Copy Link' }).first().click();
  await expect(page.getByText('Link copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);

  // Regenerate: asks first; the old link stops working.
  await page.getByRole('button', { name: 'Regenerate Link' }).first().click();
  await page.getByRole('button', { name: 'Make New Link' }).click();
  await expect(page.getByText('New link made; the old one no longer works')).toBeVisible();
  await expect(code).not.toHaveText(first);
  expect((await page.context().request.fetch(first)).status()).toBe(404);
  const second = (await code.textContent())!;
  expect((await page.context().request.fetch(second)).status()).toBe(200);

  await page.getByRole('button', { name: 'Switch Off' }).first().click();
  await expect(page.getByText('Calendar link switched off')).toBeVisible();
  await expect(mine).toBeHidden();
  expect((await page.context().request.fetch(second)).status()).toBe(404);
});
