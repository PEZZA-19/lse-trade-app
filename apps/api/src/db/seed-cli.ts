// Seeds the LOCAL dev database with the LSE business and clearly fictional demo data.
// Never point this at production: it refuses unless the database is on localhost.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app';
import { createSql } from './client';
import { migrate } from './migrate';
import { seedTenant } from './seed';
import { ADMIN_URL, APP_URL } from '../env';

const here = path.dirname(fileURLToPath(import.meta.url));
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN_URL))
  throw new Error('Refusing to seed a non-local database');

const admin = createSql(ADMIN_URL, { max: 1 });
const appSql = createSql(APP_URL, { max: 2 });
try {
  await migrate(admin, path.resolve(here, '../../migrations'), console.log);
  const [existing] = await admin<{ userId: string }[]>`
    SELECT m.user_id FROM tenants t JOIN memberships m ON m.tenant_id = t.id AND m.role = 'owner' WHERE t.slug = 'lse'`;
  let userId = existing?.userId;
  if (!userId) {
    const t = await seedTenant(admin, {
      name: 'Little Sark Electric',
      slug: 'lse',
      owner: { email: 'owner@lse.example', name: 'Joe' },
      nextJobNumber: 122,
      nextQuoteNumber: 1,
    });
    userId = t.userId;
    const app = createApp({ getSql: () => appSql, authMode: 'dev', devUserId: userId });
    const post = async (p: string, body?: unknown) => {
      const res = await app.request(p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`${p}: ${res.status} ${await res.text()}`);
      return res.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    // Fictional demo customers only (no real LSE data).
    const farm = await post('/api/customers', {
      name: 'Demo Farm Ltd',
      email: 'accounts@demo-farm.example',
      phone: '01481 000001',
      sites: [
        { label: 'Barn', address: '1 Demo Lane, Sark' },
        { label: 'Farmhouse', address: '2 Demo Lane, Sark' },
      ],
      contacts: [
        { name: 'Alex Example', role: 'bill_payer', email: 'accounts@demo-farm.example' },
        { name: 'Sam Sample', role: 'site_contact', phone: '07781 000002', siteIndex: 0 },
      ],
    });
    const cottage = await post('/api/customers', {
      name: 'Harbour View Cottage',
      email: 'owner@harbour-view.example',
      markupBp: 11000,
      sites: [{ address: 'Harbour View, Creux Harbour, Sark' }],
      contacts: [
        { name: 'Pat Owner', role: 'landlord', email: 'owner@harbour-view.example' },
        { name: 'Chris Renter', role: 'tenant', phone: '07781 000003', siteIndex: 0 },
      ],
    });
    await post('/api/customers', {
      name: 'Island Café',
      phone: '01481 000004',
      sites: [{ address: 'The Avenue, Sark' }],
    });
    const q1 = await post('/api/quotes', {
      customerId: farm.id,
      siteId: farm.sites[0].id,
      title: 'Barn rewire and LED lighting',
      notes: 'Please confirm any options that you would like.',
      lines: [
        {
          kind: 'labour',
          description: 'Strip out, first fix, second fix and test',
          qtyMilli: 24000,
        },
        {
          kind: 'material',
          description: '2.5mm twin & earth (m)',
          qtyMilli: 100000,
          unitCostPence: 95,
        },
        {
          kind: 'material',
          description: 'LED batten 5ft IP65',
          qtyMilli: 8000,
          unitCostPence: 2650,
        },
        { kind: 'material', description: '10-way consumer unit with RCBOs', unitCostPence: 18500 },
        { kind: 'carriage', description: 'Carriage', unitPricePence: 3500 },
        {
          kind: 'material',
          description: 'Dusk-to-dawn floodlight',
          unitCostPence: 4200,
          optionLabel: 'Yard floodlight',
        },
        {
          kind: 'labour',
          description: 'Fit floodlight',
          qtyMilli: 1500,
          optionLabel: 'Yard floodlight',
        },
      ],
    });
    await post(`/api/quotes/${q1.id}/send`);
    await post(`/api/quotes/${q1.id}/accept`, { acceptedOptions: ['Yard floodlight'] });
    await post(`/api/quotes/${q1.id}/convert`);
    const q2 = await post('/api/quotes', {
      customerId: cottage.id,
      siteId: cottage.sites[0].id,
      title: 'Extra sockets in kitchen',
      lines: [
        { kind: 'labour', description: 'Install 3 double sockets', qtyMilli: 4000 },
        {
          kind: 'material',
          description: 'Double socket, white',
          qtyMilli: 3000,
          unitCostPence: 450,
        },
      ],
    });
    await post(`/api/quotes/${q2.id}/send`);
    await post('/api/quotes', {
      customerId: farm.id,
      siteId: farm.sites[1].id,
      title: 'EV charger',
      lines: [],
    });
    await post('/api/jobs', {
      customerId: cottage.id,
      siteId: cottage.sites[0].id,
      title: 'Call-out: tripping RCD',
    });
    console.log('Seeded demo data for Little Sark Electric');
  }
  writeFileSync(path.resolve(here, '../../.dev.vars'), `AUTH_MODE=dev\nDEV_USER_ID=${userId}\n`);
  console.log(`DEV_USER_ID=${userId} (written to apps/api/.dev.vars)`);
} finally {
  await Promise.all([admin.end(), appSql.end()]);
}
