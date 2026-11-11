import { expect, test, type Browser, type Page } from '@playwright/test';
import { signInThroughUi } from './sign-in';

async function setSam(page: Page, preset: string, extra?: string) {
  await page.goto('/settings');
  const list = page.getByRole('list', { name: 'Access' });
  await list.getByRole('button', { name: /Sam Spark/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Sam Spark' });
  await sheet.getByRole('button', { name: preset, exact: true }).click();
  if (extra) await sheet.getByRole('switch', { name: new RegExp(extra) }).check();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  return list;
}

async function asSam(browser: Browser) {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 390, height: 844 },
  });
  const page = await ctx.newPage();
  await signInThroughUi(page, 'sam@lse.example');
  return { ctx, page };
}

test.describe.configure({ mode: 'serial' });

test('admin sets what Sam can open; Sam’s app and links follow, both ways', async ({
  page,
  browser,
}) => {
  try {
    const list = await setSam(page, 'Field worker');
    await expect(list.getByRole('button', { name: /Sam Spark/ })).toContainText('Field worker');
    // The owner can't be made non-admin.
    await list.getByRole('button', { name: /Joe/ }).click();
    const joe = page.getByRole('dialog', { name: 'Joe' });
    await expect(joe.getByRole('switch', { name: /Admin/ })).toBeDisabled();
    await expect(joe.getByText('The owner is always an admin.')).toBeVisible();
    await page.keyboard.press('Escape');

    const sam = await asSam(browser);
    await sam.page.goto('/more');
    await expect(sam.page.getByRole('link', { name: /Customers/ })).toBeVisible();
    for (const name of ['Invoices', 'Supplier Bills', 'Reports', 'Price List', 'Settings'])
      await expect(sam.page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
    await sam.page.goto('/home');
    await expect(sam.page.getByRole('button', { name: 'New job' })).toBeVisible();
    await expect(sam.page.getByRole('button', { name: 'New quote' })).toHaveCount(0);
    await sam.page.goto('/invoices');
    await expect(sam.page.getByText('Not available to you')).toBeVisible();

    // Switch accounts and reports on: they appear for Sam.
    await setSam(page, 'Office', 'Reports and profit');
    await expect(
      page.getByRole('list', { name: 'Access' }).getByRole('button', { name: /Sam Spark/ }),
    ).toContainText('Custom');
    await sam.page.goto('/more');
    await expect(sam.page.getByRole('link', { name: /Reports/ })).toBeVisible();
    await expect(sam.page.getByRole('link', { name: /Invoices/ })).toBeVisible();
    await sam.page.goto('/invoices');
    await expect(sam.page.getByRole('heading', { name: 'Invoices', level: 1 })).toBeVisible();
    await sam.ctx.close();
  } finally {
    await setSam(page, 'Office');
  }
});
