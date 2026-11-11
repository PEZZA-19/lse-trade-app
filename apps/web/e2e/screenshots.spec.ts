import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../../../screenshots');
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, scale: 3, mobile: true },
  { name: 'desktop', width: 1280, height: 800, scale: 2, mobile: false },
] as const;
const SCHEMES = ['light', 'dark'] as const;

async function shot(page: Page, name: string, vp: string, scheme: string) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(450); // let entrance transitions settle
  await page.screenshot({ path: path.join(OUT, `${vp}-${scheme}-${name}.png`) });
}

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`${vp.name} ${scheme}`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.scale,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await page.goto('/jobs');
      await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
      await expect(page.getByText('Barn rewire and LED lighting')).toBeVisible();
      await shot(page, '01-jobs', vp.name, scheme);

      await page.getByText('Barn rewire and LED lighting').click();
      await expect(page.getByRole('heading', { name: 'Job 122' })).toBeVisible();
      await shot(page, '02-job-detail', vp.name, scheme);

      await page.goto('/quotes');
      await expect(page.getByRole('heading', { name: 'Quotes', level: 1 })).toBeVisible();
      await shot(page, '03-quotes', vp.name, scheme);

      await page.getByText('EV charger').click();
      await expect(page.getByRole('heading', { name: 'Q-0003' })).toBeVisible();
      await shot(page, '04-quote-draft', vp.name, scheme);

      await page.getByText('7kW EV charger, tethered').click();
      await expect(page.getByRole('dialog', { name: 'Edit Line' })).toBeVisible();
      await shot(page, '05-line-sheet', vp.name, scheme);
      await page.keyboard.press('Escape');

      await page.goto('/quotes');
      await page.getByText('Glasshouse heating supply').click();
      await expect(page.getByRole('button', { name: 'Create job' })).toBeVisible();
      await shot(page, '06-quote-accepted', vp.name, scheme);

      await page.goto('/customers');
      await expect(page.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible();
      await shot(page, '07-customers', vp.name, scheme);

      await page.getByText('Harbour View Cottage').click();
      await expect(page.getByRole('heading', { name: 'Harbour View Cottage' })).toBeVisible();
      await shot(page, '08-customer-detail', vp.name, scheme);

      await page.goto('/quotes');
      await page.getByRole('button', { name: 'New quote' }).click();
      await expect(page.getByRole('dialog', { name: 'New Quote' })).toBeVisible();
      await shot(page, '09-new-quote-sheet', vp.name, scheme);
      await ctx.close();
    });
  }
}
