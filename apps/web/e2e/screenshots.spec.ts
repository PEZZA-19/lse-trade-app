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
      test.setTimeout(240_000); // 33 screens per pass
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
      await page.getByRole('list', { name: 'Stage history' }).scrollIntoViewIfNeeded();
      await shot(page, '11-job-history', vp.name, scheme);

      await page.goto('/jobs');
      await page.getByRole('button', { name: 'Stage…' }).click();
      await expect(page.getByRole('dialog', { name: 'Show stage' })).toBeVisible();
      await shot(page, '12-stage-picker', vp.name, scheme);
      await page.keyboard.press('Escape');

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

      await page.goto('/home');
      await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Running timer' })).toBeVisible();
      await shot(page, '14-home', vp.name, scheme);

      await page.goto('/schedule?view=day');
      await expect(page.getByRole('button', { name: /Barn rewire/ })).toBeVisible();
      await shot(page, '15-schedule-day', vp.name, scheme);
      await page.getByRole('button', { name: 'Week', exact: true }).click();
      await shot(page, '16-schedule-week', vp.name, scheme);
      await page.getByRole('button', { name: 'Month', exact: true }).click();
      await shot(page, '17-schedule-month', vp.name, scheme);
      await page.getByRole('button', { name: 'Day', exact: true }).click();
      await page.getByRole('button', { name: /Barn rewire/ }).click();
      await expect(page.getByRole('dialog', { name: 'Job 122' })).toBeVisible();
      await shot(page, '18-appointment-sheet', vp.name, scheme);
      await page.keyboard.press('Escape');

      await page.goto('/more');
      await expect(page.getByRole('heading', { name: 'More', level: 1 })).toBeVisible();
      await shot(page, '19-more', vp.name, scheme);

      // Invoices (More → Invoices, and on the job).
      await page
        .getByRole('main')
        .getByRole('link', { name: /Invoices/ })
        .click();
      await expect(page.getByRole('heading', { name: 'Invoices', level: 1 })).toBeVisible();
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await expect(page.getByRole('link', { name: /Invoice 122\b/ })).toBeVisible();
      await shot(page, '20-invoices', vp.name, scheme);
      await page.getByRole('link', { name: /Draft · job 122/ }).click();
      await expect(page.getByRole('heading', { name: 'Draft Invoice' })).toBeVisible();
      await shot(page, '21-invoice-draft', vp.name, scheme);
      await page.getByRole('button', { name: 'Approve Invoice…' }).click();
      await expect(page.getByRole('dialog', { name: 'Approve Invoice' })).toBeVisible();
      await shot(page, '22-approve-confirm', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/invoices');
      await page.getByRole('link', { name: /Coupée View Hotel/ }).click();
      await expect(page.getByRole('button', { name: 'Record Payment…' })).toBeVisible();
      await shot(page, '23-invoice-part-paid', vp.name, scheme);
      await page.getByRole('button', { name: 'Record Payment…' }).click();
      await expect(page.getByRole('dialog', { name: 'Record Payment' })).toBeVisible();
      await shot(page, '24-payment-sheet', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/jobs');
      await page.getByText('Barn rewire and LED lighting').click();
      await page.getByRole('list', { name: 'Invoices for this job' }).scrollIntoViewIfNeeded();
      await shot(page, '25-job-invoices', vp.name, scheme);
      await page.getByRole('button', { name: 'New invoice…' }).click();
      await expect(page.getByRole('dialog', { name: 'New Invoice' })).toBeVisible();
      await shot(page, '26-new-invoice-sheet', vp.name, scheme);
      await page.keyboard.press('Escape');

      // Price list, import and kits.
      await page.goto('/price-list');
      await expect(page.getByRole('heading', { name: 'Price List', level: 1 })).toBeVisible();
      await shot(page, '27-price-list', vp.name, scheme);
      await page.getByText('2.5mm twin & earth cable').click();
      await expect(page.getByRole('list', { name: 'Price history' })).toBeVisible();
      await shot(page, '28-price-item', vp.name, scheme);
      await page.goto('/price-list');
      await page.getByRole('button', { name: 'Import' }).click();
      const imp = page.getByRole('dialog', { name: 'Import Price List' });
      await imp
        .getByRole('textbox', { name: 'CSV' })
        .fill(
          'Code,Description,Unit,Supplier,Cost\nSKT2,Double switched socket,each,Island Electrical (demo),3.45\nFSP13,Fused spur 13A,each,Island Electrical (demo),4.20\nBAD,Broken row,each,,n/a\n',
        );
      await imp.getByRole('button', { name: 'Preview' }).click();
      await expect(imp.getByText('Nothing is saved yet')).toBeVisible();
      await shot(page, '29-import-preview', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/kits');
      await expect(page.getByRole('heading', { name: 'Kits', level: 1 })).toBeVisible();
      await shot(page, '30-kits', vp.name, scheme);
      await page.getByText('Double socket on new radial').click();
      await expect(page.getByRole('list', { name: 'Kit cost changes' })).toBeVisible();
      await shot(page, '31-kit-detail', vp.name, scheme);
      await page.getByRole('list', { name: 'Kit cost changes' }).scrollIntoViewIfNeeded();
      await shot(page, '31b-kit-cost-changes', vp.name, scheme);
      await page.goto('/quotes');
      await page.getByText('Extra kitchen sockets').click();
      await expect(page.getByText(/Kit price now/)).toBeVisible();
      await page.getByRole('list', { name: 'Quote lines' }).scrollIntoViewIfNeeded();
      await shot(page, '32-quote-kit', vp.name, scheme);
      await page.getByRole('button', { name: /Double socket on new radial/ }).click();
      await expect(page.getByRole('dialog', { name: 'Double socket on new radial' })).toBeVisible();
      await shot(page, '33-kit-line-sheet', vp.name, scheme);
      await page.keyboard.press('Escape');

      await page.goto('/settings');
      await expect(page.getByLabel('Labour rate (£/hr)')).toHaveValue('45.00');
      await shot(page, '10-settings', vp.name, scheme);
      await page.getByRole('list', { name: 'Job stages' }).scrollIntoViewIfNeeded();
      await shot(page, '13-settings-stages', vp.name, scheme);
      await ctx.close();
    });
  }
}
