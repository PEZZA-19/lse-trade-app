import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/** Server-side helper using the same signed-in session (cookie) plus its CSRF token. */
async function serverApi(request: APIRequestContext) {
  const session = await (await request.get('/api/auth/session')).json();
  const headers = { 'x-csrf-token': session.csrfToken as string };
  return {
    get: async (path: string) => (await request.get(`/api${path}`)).json(),
    post: async (path: string, data: unknown) =>
      (await request.post(`/api${path}`, { data, headers })).json(),
    patch: async (path: string, data: unknown) =>
      (await request.patch(`/api${path}`, { data, headers })).json(),
  };
}

async function newJob(page: Page, title: string) {
  const api = await serverApi(page.request);
  const customers = await api.get('/customers?q=Demo%20Farm');
  const job = await api.post('/jobs', { customerId: customers.items[0].id, title });
  const stages: { id: string; systemKey: string | null }[] = await api.get('/job-stages');
  const stage = (key: string) => stages.find((s) => s.systemKey === key)!.id;
  const serverStage = async () => (await api.get(`/jobs/${job.id}`)).stage.systemKey as string;
  return { api, job, stage, serverStage };
}

const STAGE_NAME: Record<string, string> = {
  unassigned: 'Unassigned',
  scheduled: 'Booked in',
  in_progress: 'In Progress',
  complete: 'Complete',
};
const stageButton = (page: Page) => page.getByRole('button', { name: /^Stage: / });
const expectStage = (page: Page, key: string) =>
  expect(stageButton(page)).toHaveAccessibleName(`Stage: ${STAGE_NAME[key]}`);
async function pickStage(page: Page, key: string) {
  await stageButton(page).click();
  await page
    .getByRole('listbox', { name: 'Stage' })
    .getByRole('option', { name: STAGE_NAME[key], exact: true })
    .click();
}

test('offline: a stage change is kept on the device and syncs when signal returns', async ({
  page,
  context,
}) => {
  const { job, serverStage } = await newJob(page, `Offline test ${Date.now()}`);
  await page.goto(`/jobs/${job.id}`);
  await expectStage(page, 'unassigned');

  await context.setOffline(true);
  await expect(page.getByText('You’re offline.')).toBeVisible();
  await pickStage(page, 'scheduled');
  await expect(page.getByText(/on this device\. It will sync/)).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '1 change saved on this device, waiting for signal' }),
  ).toBeVisible();
  // Honest: the server still has the old value.
  expect(await serverStage()).toBe('unassigned');

  await context.setOffline(false);
  await expect(page.getByRole('link', { name: /waiting/ })).toHaveCount(0);
  await expect.poll(serverStage).toBe('scheduled');
  await page.reload();
  await expectStage(page, 'scheduled');
});

test('offline conflict: same field changed elsewhere → asks, and "Keep mine" wins', async ({
  page,
  context,
}) => {
  const { api, job, serverStage } = await newJob(page, `Conflict test ${Date.now()}`);
  await page.goto(`/jobs/${job.id}`);
  await expectStage(page, 'unassigned');

  await context.setOffline(true);
  await pickStage(page, 'complete');
  await expect(page.getByText(/on this device\. It will sync/)).toBeVisible();
  // Meanwhile, someone else cancels the job from another device.
  await api.patch(`/jobs/${job.id}`, { stageKey: 'cancelled' });

  await context.setOffline(false);
  const badge = page.getByRole('status').filter({ hasText: '1 change needs your attention' });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.getByText(/changed on another device/)).toBeVisible();
  await expect(page.getByText('Yours: Complete · Other device: Cancelled')).toBeVisible();
  await page.getByRole('button', { name: 'Keep mine' }).click();
  await expect(page.getByRole('heading', { name: 'Everything is synced' })).toBeVisible();
  expect(await serverStage()).toBe('complete');
});

test('offline: different fields changed elsewhere merge without asking', async ({
  page,
  context,
}) => {
  const { api, job, serverStage } = await newJob(page, `Merge test ${Date.now()}`);
  await page.goto(`/jobs/${job.id}`);
  await expectStage(page, 'unassigned');
  await context.setOffline(true);
  await pickStage(page, 'in_progress');
  await api.patch(`/jobs/${job.id}`, { title: 'Renamed on the laptop' });
  await context.setOffline(false);
  await expect.poll(serverStage).toBe('in_progress');
  const server = await api.get(`/jobs/${job.id}`);
  expect(server.title).toBe('Renamed on the laptop');
  await expect(page.getByRole('status').filter({ hasText: 'needs your attention' })).toHaveCount(0);
});

test('offline quote edit: saved on the device, "Mark as sent" waits until it reaches the server', async ({
  page,
  context,
}) => {
  const api = await serverApi(page.request);
  const customers = await api.get('/customers?q=Demo%20Farm');
  const quote = await api.post('/quotes', {
    customerId: customers.items[0].id,
    title: `Offline quote ${Date.now()}`,
    lines: [],
  });
  await page.goto(`/quotes/${quote.id}`);
  await expect(page.getByRole('heading', { name: quote.number })).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Add line' }).click();
  const line = page.getByRole('dialog', { name: 'Add Line' });
  await line.getByRole('button', { name: 'Labour' }).click();
  await line.getByLabel('Description').fill('Fault finding');
  await line.getByLabel('Hours').fill('2');
  await line.getByRole('button', { name: 'Add' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: 'Saved on this device · will sync' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as sent' })).toBeDisabled();
  await expect(page.getByText('haven’t reached the server yet')).toBeVisible();
  expect((await api.get(`/quotes/${quote.id}`)).current.lines).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as sent' })).toBeEnabled();
  const server = await api.get(`/quotes/${quote.id}`);
  expect(server.current.lines.map((l: { description: string }) => l.description)).toEqual([
    'Fault finding',
  ]);
});

test('offline create: a job and a customer are saved on the device, then made once when signal returns', async ({
  page,
  context,
}) => {
  const api = await serverApi(page.request);
  const stamp = Date.now();
  const name = `Offline Customer ${stamp}`;
  const title = `Offline job ${stamp}`;
  const customerCount = async () =>
    (await api.get(`/customers?q=${encodeURIComponent(name)}`)).items.length;
  const jobCount = async () => (await api.get(`/jobs?q=${encodeURIComponent(title)}`)).items.length;

  // Open the New Job sheet with signal so the customer list is loaded, then lose signal.
  await page.goto('/jobs');
  await page.getByRole('button', { name: 'New job' }).first().click();
  const customer = page.getByRole('combobox', { name: 'Customer' });
  await expect(customer.locator('option', { hasText: 'Demo Farm Ltd' })).toHaveCount(1);
  await context.setOffline(true);
  await expect(page.getByText('You’re offline.')).toBeVisible();
  await customer.selectOption({ label: 'Demo Farm Ltd' });
  await page.getByLabel('What’s the job?').fill(title);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(/the job is saved on this phone/)).toBeVisible();
  const pendingJobs = page.getByRole('list', { name: 'New jobs waiting to sync' });
  await expect(pendingJobs.getByText(title)).toBeVisible();
  await expect(pendingJobs.getByText('Waiting')).toBeVisible();

  // A new customer, still offline (in-app navigation: no page load needed).
  // Phones reach Customers through More; wide screens have it in the sidebar.
  const more = page.getByRole('link', { name: 'More' });
  if (await more.isVisible()) await more.click();
  await page.getByRole('link', { name: 'Customers' }).first().click();
  await page.getByRole('button', { name: 'Add customer' }).first().click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/the customer is saved on this phone/)).toBeVisible();
  const pendingCustomers = page.getByRole('list', { name: 'New customers waiting to sync' });
  await expect(pendingCustomers.getByText(name)).toBeVisible();
  // Honest: neither is on the server yet.
  expect(await customerCount()).toBe(0);
  expect(await jobCount()).toBe(0);

  await context.setOffline(false);
  await expect(pendingCustomers).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
  // Made exactly once each.
  await expect.poll(customerCount).toBe(1);
  await expect.poll(jobCount).toBe(1);
});
