import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sample = (name: string) =>
  fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));

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
      test.setTimeout(600_000); // 58 screens per pass
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.scale,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        colorScheme: scheme,
        reducedMotion: 'reduce',
        locale: 'en-GB',
        timezoneId: 'Europe/Guernsey',
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

      // Quote and invoice PDFs (the LSE layout), supplier bills and suppliers.
      await page.goto('/quotes');
      await page.getByText('EV charger').click();
      await page.getByRole('button', { name: /Preview PDF/ }).click();
      await expect(page.getByRole('article', { name: /preview/ })).toBeVisible();
      await shot(page, '34-quote-pdf', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/invoices');
      await page.getByRole('link', { name: /Coupée View Hotel/ }).click();
      await page.getByRole('button', { name: /Preview PDF/ }).click();
      await expect(page.getByRole('article', { name: /preview/ })).toBeVisible();
      await shot(page, '35-invoice-pdf', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /Credit note CN-0001/ }).click();
      await expect(page.getByRole('dialog', { name: 'Credit Note CN-0001' })).toBeVisible();
      await shot(page, '43-credit-note', vp.name, scheme);
      await page
        .getByRole('button', { name: /Preview PDF/ })
        .last()
        .click();
      await expect(page.getByRole('article', { name: /preview/ })).toBeVisible();
      await shot(page, '44-credit-note-pdf', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/bills');
      await expect(page.getByRole('heading', { name: 'Supplier Bills', level: 1 })).toBeVisible();
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await expect(page.getByRole('link', { name: /IE-40388/ })).toBeVisible();
      await shot(page, '36-bills', vp.name, scheme);
      await page.getByRole('link', { name: /IE-40388/ }).click();
      await expect(page.getByRole('list', { name: 'Bill lines' })).toBeVisible();
      await shot(page, '37-bill-detail', vp.name, scheme);
      await page.getByRole('button', { name: 'Review and Apply…' }).click();
      await expect(page.getByText('Nothing has changed yet')).toBeVisible();
      await shot(page, '38-bill-review', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /Cable ties/ }).click();
      await expect(page.getByRole('dialog', { name: 'Bill Line' })).toBeVisible();
      await shot(page, '39-bill-line-sheet', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/bills');
      await page.getByRole('button', { name: 'New bill' }).click();
      const nb = page.getByRole('dialog', { name: 'New Bill' });
      await nb.getByLabel('Supplier').fill('Sarnia Wholesale (demo)');
      await nb.getByLabel('Bill reference').fill('SW-55120');
      await nb.getByRole('button', { name: 'CSV' }).click();
      await nb
        .getByRole('textbox', { name: 'Bill CSV' })
        .fill(
          'Code,Description,Qty,Unit cost\nBB35,Flush back box 35mm,20,0.58\nGLD20,20mm SWA gland kit,4,2.35\n',
        );
      await expect(nb.getByText(/2 lines read/)).toBeVisible();
      await shot(page, '40-new-bill-sheet', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/suppliers');
      await expect(page.getByRole('heading', { name: 'Suppliers', level: 1 })).toBeVisible();
      await shot(page, '41-suppliers', vp.name, scheme);
      await page.getByRole('link', { name: /Island Electrical/ }).click();
      await expect(page.getByRole('link', { name: /IE-40112/ })).toBeVisible();
      await shot(page, '42-supplier-detail', vp.name, scheme);

      // Inbox: enquiries and AI drafts waiting for the owner (all fictional, fake model).
      await page.goto('/home');
      await expect(page.getByRole('navigation', { name: 'Inbox' })).toBeVisible();
      await shot(page, '45-home-inbox', vp.name, scheme);
      await page.goto('/approvals');
      await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
      await expect(page.getByText('Will do:').first()).toBeVisible();
      await shot(page, '46-approvals', vp.name, scheme);
      await page.getByRole('link', { name: 'Reply to Robin Demo' }).click();
      await expect(page.getByRole('list', { name: 'Log' })).toBeVisible();
      await shot(page, '47-approval-detail', vp.name, scheme);
      await page.goto('/enquiries');
      await expect(page.getByRole('link', { name: /Harbour Café/ })).toBeVisible();
      await shot(page, '48-enquiries', vp.name, scheme);
      await page.getByRole('link', { name: /Harbour Café/ }).click();
      await expect(page.getByRole('button', { name: 'Draft a Quote' })).toBeVisible();
      await shot(page, '49-enquiry-detail', vp.name, scheme);
      await page.goto('/reports');
      await page.getByRole('button', { name: 'This Year' }).click();
      await expect(page.getByRole('list', { name: 'Profit per job' })).toBeVisible();
      await shot(page, '50-reports', vp.name, scheme);
      // Supplier PDFs read on the device (synthetic samples with the real layouts).
      await page.goto('/bills');
      await page.getByRole('button', { name: 'New bill' }).click();
      const pdf = page.getByRole('dialog', { name: 'New Bill' });
      await pdf.getByRole('button', { name: 'PDF' }).click();
      await pdf.getByLabel('Bill PDF').setInputFiles(sample('sample-cef-invoices.pdf'));
      await expect(pdf.getByText('Adds up')).toHaveCount(4);
      await shot(page, '51-bill-pdf-import', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/bills');
      await page
        .getByLabel('Statement PDF')
        .setInputFiles(sample('sample-cilighting-statement.pdf'));
      await expect(page.getByText('Balance checks')).toBeVisible();
      await shot(page, '52-statement-check', vp.name, scheme);

      // Cost rates (placeholders in the demo) and true profit on the job.
      await page.goto('/settings');
      const team = page.getByRole('list', { name: 'Team' });
      await expect(team).toContainText('Sam Spark');
      await team.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await shot(page, '53-settings-team', vp.name, scheme);
      await team.getByRole('button', { name: /Joe/ }).click();
      await expect(page.getByText('Total cost per hour')).toBeVisible();
      // Show tax and on-costs as a percentage (not saved): £20 + 22.5% = £24.50.
      const costSheet = page.getByRole('dialog', { name: 'Joe' });
      await costSheet.getByRole('button', { name: '% of base' }).click();
      await costSheet.getByLabel('Tax and on-costs (%)').fill('22.5');
      await expect(costSheet.getByText('£24.50/h')).toBeVisible();
      await shot(page, '54-team-cost-sheet', vp.name, scheme);
      await page.keyboard.press('Escape');
      await page.goto('/jobs');
      await page.getByText('Barn rewire and LED lighting').click();
      const qva = page.getByRole('list', { name: 'Quote vs actual' });
      await qva.scrollIntoViewIfNeeded();
      await expect(qva).toContainText('Labour at cost');
      await shot(page, '55-job-quote-vs-actual', vp.name, scheme);

      // Job detail: time and materials by hand, notes, photos (all made-up demo values).
      const time = page.getByRole('list', { name: 'Timesheet entries' });
      await time.scrollIntoViewIfNeeded();
      await time.getByRole('button', { name: 'Log Time…' }).click();
      let sheet = page.getByRole('dialog', { name: 'Log Time' });
      const d = new Date(Date.now() - 3 * 86_400_000);
      await sheet
        .getByLabel('Date')
        .fill(
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        );
      await sheet.getByLabel('Start').fill('08:00');
      await sheet.getByLabel('End').fill('10:30');
      await sheet.getByLabel('Note').fill('Second fix, workshop end');
      await expect(sheet.getByText('2 h 30 min')).toBeVisible();
      await shot(page, '56-job-log-time', vp.name, scheme);
      await sheet.getByRole('button', { name: 'Save' }).click();
      await expect(sheet).toBeHidden();

      const mats = page.getByRole('list', { name: 'Materials and extras' });
      await mats.getByRole('button', { name: 'Add Material…' }).click();
      sheet = page.getByRole('dialog', { name: 'Add Material' });
      await sheet.getByLabel('Item').fill('Lever connectors (box of 50)');
      await sheet.getByLabel('Quantity').fill('1');
      await sheet.getByLabel('Cost each (£)').fill('18.40');
      await expect(sheet.getByText('£23.92')).toBeVisible();
      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 8000 });
      await shot(page, '57-job-add-material', vp.name, scheme);
      await sheet.getByRole('button', { name: 'Add' }).click();
      await expect(sheet).toBeHidden();

      const notes = page.getByRole('list', { name: 'Job notes' });
      await notes.getByRole('button', { name: 'Add Note…' }).click();
      sheet = page.getByRole('dialog', { name: 'Add Note' });
      await sheet
        .getByLabel('Note')
        .fill('Isolator is behind the feed bins.\nGate code is on the job sheet.');
      await sheet.getByRole('button', { name: 'Add' }).click();
      await expect(sheet).toBeHidden();
      // A drawn placeholder image, not a real photo.
      const png = await page.evaluate(async () => {
        const c = new OffscreenCanvas(1200, 900);
        const g = c.getContext('2d')!;
        const grad = g.createLinearGradient(0, 0, 1200, 900);
        grad.addColorStop(0, '#d9dde3');
        grad.addColorStop(1, '#9aa3ad');
        g.fillStyle = grad;
        g.fillRect(0, 0, 1200, 900);
        g.fillStyle = '#f4f5f7';
        g.fillRect(300, 220, 600, 460);
        g.fillStyle = '#2b2f36';
        for (let i = 0; i < 10; i++) g.fillRect(340 + i * 54, 380, 34, 120);
        g.fillStyle = '#1f7ae0';
        g.fillRect(340, 300, 520, 40);
        g.fillStyle = '#6b7380';
        g.font = '600 44px sans-serif';
        g.fillText('DEMO IMAGE', 470, 620);
        const b = await c.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await b.arrayBuffer());
        let s = '';
        for (const x of bytes) s += String.fromCharCode(x);
        return btoa(s);
      });
      await page.getByTestId('photo-input').setInputFiles({
        name: 'board.png',
        mimeType: 'image/png',
        buffer: Buffer.from(png, 'base64'),
      });
      sheet = page.getByRole('dialog', { name: 'Add Photo' });
      await sheet.getByLabel('Caption').fill('Board before');
      await sheet.getByRole('button', { name: 'Upload' }).click();
      await expect(sheet).toBeHidden();
      await notes.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.evaluate(() => window.scrollBy(0, -60));
      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 8000 });
      await shot(page, '58-job-notes-photos', vp.name, scheme);

      await page.goto('/settings');
      await expect(page.getByLabel('Labour rate (£/hr)')).toHaveValue('45.00');
      await shot(page, '10-settings', vp.name, scheme);
      await page.getByRole('list', { name: 'Job stages' }).scrollIntoViewIfNeeded();
      await shot(page, '13-settings-stages', vp.name, scheme);
      await ctx.close();
    });
  }
}
