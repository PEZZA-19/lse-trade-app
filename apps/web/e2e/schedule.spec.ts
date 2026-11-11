import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, title: string) {
  const session = await (await page.request.get('/api/auth/session')).json();
  const headers = { 'x-csrf-token': session.csrfToken as string };
  const api = {
    get: async (p: string) => (await page.request.get(`/api${p}`)).json(),
    post: async (p: string, data?: unknown) =>
      (await page.request.post(`/api${p}`, { data: data ?? {}, headers })).json(),
  };
  // Start clean: no timer running for the owner.
  const running = await api.get('/timer');
  if (running) await api.post(`/jobs/${running.jobId}/timer/stop`);
  const customers = await api.get('/customers?q=Demo%20Farm');
  const job = await api.post('/jobs', { customerId: customers.items[0].id, title });
  return { api, job };
}

test('timer: start and stop with no signal, synced later with a timesheet entry', async ({
  page,
  context,
}) => {
  const { api, job } = await setup(page, `Timer test ${Date.now()}`);
  await page.goto(`/jobs/${job.id}`);
  await expect(page.getByRole('heading', { name: `Job ${job.number}` })).toBeVisible();
  await expect(page.getByText('Not running')).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('button', { name: `Start timer on job ${job.number}` }).click();
  await expect(page.getByText(/Timer started on this device/)).toBeVisible();
  await expect(page.getByRole('timer')).toBeVisible();
  expect((await api.get(`/jobs/${job.id}`)).timerRunning).toBe(false); // honest: not on the server yet

  await context.setOffline(false);
  await expect.poll(async () => (await api.get(`/jobs/${job.id}`)).timerRunning).toBe(true);
  expect((await api.get(`/jobs/${job.id}`)).stage.systemKey).toBe('in_progress');

  await context.setOffline(true);
  await page.getByRole('button', { name: `Stop timer on job ${job.number}` }).click();
  await expect(page.getByText(/Timer stopped on this device/)).toBeVisible();
  await context.setOffline(false);
  await expect.poll(async () => (await api.get(`/jobs/${job.id}`)).timesheets.length).toBe(1);
  await page.reload();
  await expect(page.getByRole('list', { name: 'Timesheet entries' })).toBeVisible();
});

test('assign, book from the job, move and delete on the Schedule; stages follow', async ({
  page,
}) => {
  const title = `Schedule test ${Date.now()}`;
  const { api, job } = await setup(page, title);
  await page.goto(`/jobs/${job.id}`);

  await page.getByRole('button', { name: 'Assign someone…' }).click();
  await page
    .getByRole('dialog', { name: 'Assign' })
    .getByRole('button', { name: /Sam Spark/ })
    .click();
  await expect(page.getByText(`Sam Spark assigned to job ${job.number} · Assigned`)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.getByRole('list', { name: 'Assigned to' }).getByText('Sam Spark'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Book appointment…' }).click();
  const sheet = page.getByRole('dialog', { name: `Book job ${job.number}` });
  await sheet.getByLabel('Starts').fill('10:00');
  await sheet.getByLabel('Ends').fill('11:00');
  await sheet.getByRole('button', { name: 'Book' }).click();
  await expect(
    page.getByText(new RegExp(`Job ${job.number} booked for .*10:00 · Booked in`)),
  ).toBeVisible();
  const date = (await api.get(`/jobs/${job.id}`)).appointments[0].startsAt as string;

  // Open the day on the Schedule and move it with the sheet (works without dragging).
  const d = new Date(date);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await page.goto(`/schedule?view=day&date=${day}`);
  const event = page.getByRole('button', {
    name: new RegExp(`Job ${job.number}, ${title}, 10:00–11:00`),
  });
  await expect(event).toBeVisible();
  await event.click();
  const edit = page.getByRole('dialog', { name: `Job ${job.number}` });
  await edit.getByLabel('Starts').fill('13:00');
  await edit.getByLabel('Ends').fill('14:30');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(`Job ${job.number}, ${title}, 13:00–14:30`) }),
  ).toBeVisible();

  // Delete: last appointment gone → back to Assigned (Sam is still assigned).
  await page.getByRole('button', { name: new RegExp(`Job ${job.number}, ${title}`) }).click();
  await page.getByRole('button', { name: 'Delete appointment' }).click();
  await expect(
    page.getByText(`Appointment deleted · job ${job.number} is now Assigned`),
  ).toBeVisible();
  expect((await api.get(`/jobs/${job.id}`)).stage.systemKey).toBe('assigned');
});

test('drag an appointment to a new time (mouse)', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Touch uses press-and-hold; covered by the sheet test on phones.');
  const title = `Drag test ${Date.now()}`;
  const { api, job } = await setup(page, title);
  const start = new Date();
  start.setHours(9, 0, 0, 0);
  await api.post(`/jobs/${job.id}/appointments`, {
    startsAt: start.toISOString(),
    endsAt: new Date(+start + 3600_000).toISOString(),
  });
  await page.goto('/schedule?view=day');
  const event = page.getByRole('button', {
    name: new RegExp(`Job ${job.number}, ${title}, 09:00–10:00`),
  });
  await event.scrollIntoViewIfNeeded();
  const box = (await event.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 40, { steps: 4 });
  await page.mouse.move(box.x + 20, box.y + 10 + 56 * 2, { steps: 6 }); // two hours down
  await page.mouse.up();
  await expect(page.getByText(new RegExp(`Job ${job.number} moved to .*11:00`))).toBeVisible();
  const moved = (await api.get(`/jobs/${job.id}`)).appointments[0];
  expect(new Date(moved.startsAt).getHours()).toBe(11);
});

test('Home shows the running timer and today; five tabs with Customers and Settings under More', async ({
  page,
  isMobile,
}) => {
  const title = `Home test ${Date.now()}`;
  const { api, job } = await setup(page, title);
  const soon = new Date();
  soon.setMinutes(0, 0, 0);
  const end = new Date(+soon + 30 * 60_000);
  if (end.getDate() !== soon.getDate()) soon.setMinutes(-30); // keep it today near midnight
  await api.post(`/jobs/${job.id}/appointments`, {
    startsAt: soon.toISOString(),
    endsAt: new Date(+soon + 30 * 60_000).toISOString(),
  });
  await api.post(`/jobs/${job.id}/timer/start`);
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);
  const card = page.getByRole('region', { name: 'Running timer' });
  await expect(card.getByText(`Job ${job.number} · ${title}`)).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Today’s appointments' }).getByText(`${job.number} · ${title}`),
  ).toBeVisible();
  await card.getByRole('button', { name: `Stop timer on job ${job.number}` }).click();
  await expect(page.getByText(`Timer stopped. Time added to job ${job.number}.`)).toBeVisible();

  if (isMobile) {
    const tabs = page.locator('nav.tabbar').getByRole('link');
    await expect(tabs).toHaveText([
      /^\d*Home(, \d+ to check)?$/,
      'Jobs',
      'Schedule',
      'Quotes',
      'More',
    ]);
    await tabs.filter({ hasText: 'More' }).click();
    await page.getByRole('link', { name: /Customers/ }).click();
    await expect(page.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible();
    await expect(tabs.filter({ hasText: 'More' })).toHaveClass(/is-current/);
  }
});
