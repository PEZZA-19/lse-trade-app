import { expect, test } from '@playwright/test';

// Uses only the public demo fixture through playwright.screens.config.ts; no API or private seed.
for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 1280, height: 800 },
]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`Schedule picker ${viewport.width}×${viewport.height} ${colorScheme}`, async ({
      browser,
    }) => {
      const touch = viewport.width < 900;
      const context = await browser.newContext({
        viewport,
        colorScheme,
        hasTouch: touch,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.goto('/schedule?view=day');
      await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => !!localStorage.getItem('lse-demo-db-v6')))
        .toBe(true);
      await page.evaluate(() => {
        const key = 'lse-demo-db-v6';
        const db = JSON.parse(localStorage.getItem(key)!) as {
          jobs: Array<{ id: string; number: string; seq: number; title: string; stageId: string }>;
          stages: Array<{ id: string; isActive: boolean }>;
          appointments: unknown[];
        };
        const template = db.jobs[0]!;
        db.jobs = Array.from({ length: 40 }, (_, i) => ({
          ...template,
          id: crypto.randomUUID(),
          number: `${800 + i}`,
          seq: 800 + i,
          stageId: db.stages.find((s) => s.isActive)!.id,
          title: `Picker fixture ${i} · ${'Readable long job title '.repeat(6)}${'x'.repeat(60)}`,
        }));
        db.appointments = [];
        localStorage.setItem(key, JSON.stringify(db));
      });
      await page.reload();
      const launcher = page.getByRole('button', { name: 'New appointment', exact: true });
      await launcher.click();
      const sheet = page.getByRole('dialog', { name: 'New appointment' });
      await sheet.getByLabel('Starts', { exact: true }).fill('09:00');
      await sheet.getByLabel('Ends', { exact: true }).fill('10:00');
      const trigger = sheet.getByRole('button', { name: 'Job Choose a job…' });
      if (touch) await trigger.tap();
      else await trigger.click();
      const list = sheet.getByRole('listbox', { name: 'Job', exact: true });
      await expect(list.getByRole('option')).toHaveCount(40);
      await expect(list).toBeFocused();
      const checkBounds = async () => {
        const box = (await list.boundingBox())!;
        const panel = (await sheet.boundingBox())!;
        const size = page.viewportSize()!;
        expect(box.x).toBeGreaterThanOrEqual(panel.x);
        expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
        expect(box.y).toBeGreaterThanOrEqual(panel.y);
        expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height + 1);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height);
        const metrics = await list.evaluate((el) => ({
          scrollable: el.scrollHeight > el.clientHeight,
          noHorizontalOverflow: el.scrollWidth <= el.clientWidth,
          background: getComputedStyle(el).backgroundColor,
          color: getComputedStyle(el).color,
          heights: Array.from(el.children).map((c) => c.getBoundingClientRect().height),
        }));
        expect(metrics.scrollable).toBe(true);
        expect(metrics.noHorizontalOverflow).toBe(true);
        expect(metrics.background).toBe(
          colorScheme === 'dark' ? 'rgb(28, 28, 30)' : 'rgb(255, 255, 255)',
        );
        expect(metrics.color).toBe(colorScheme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
        expect(Math.min(...metrics.heights)).toBeGreaterThanOrEqual(44);
      };
      await checkBounds();
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 80 });
      await list.scrollIntoViewIfNeeded();
      await checkBounds();
      await list.press('End');
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      const last = list.getByRole('option').last();
      await last.scrollIntoViewIfNeeded();
      if (touch) await last.tap();
      else await list.press('Enter');
      await expect(list).toBeHidden();
      const selected = sheet.getByRole('button', { name: /Job \d+ · Picker fixture/ });
      await expect(selected).toBeFocused();
      const appointments = () =>
        page.evaluate(
          () =>
            (JSON.parse(localStorage.getItem('lse-demo-db-v6')!) as { appointments: unknown[] })
              .appointments.length,
        );
      expect(await appointments()).toBe(0);
      await selected.click();
      await list.press('Escape');
      await expect(sheet).toBeVisible();
      await expect(selected).toBeFocused();
      await selected.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(launcher).toBeFocused();
      expect(await appointments()).toBe(0);
      await launcher.click();
      await sheet.getByLabel('Starts', { exact: true }).fill('09:00');
      await sheet.getByLabel('Ends', { exact: true }).fill('10:00');
      await trigger.click();
      await list.press('Home');
      await list.press('Enter');
      await sheet.getByRole('button', { name: 'Book', exact: true }).click();
      await expect(sheet).toBeHidden();
      expect(await appointments()).toBe(1);
      await context.close();
    });
  }
}
