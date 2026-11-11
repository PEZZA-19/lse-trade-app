/**
 * Fictional demo data, used to seed the local dev database and the static preview build.
 * Every name, address, phone and email here is made up. No real customer data.
 * It drives the public API (POST only), so it exercises the same rules as real use.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Post = (path: string, body?: unknown) => Promise<any>;
type Patch = (path: string, body: unknown) => Promise<any>;

export async function runDemoScript(post: Post, patch: Patch): Promise<void> {
  const farm = await post('/customers', {
    name: 'Demo Farm Ltd',
    email: 'accounts@demo-farm.example',
    phone: '01481 830001',
    billingAddress: 'Demo Farm, Rue du Demo, Sark',
    sites: [
      { label: 'Barn', address: 'Demo Farm Barn, Rue du Demo, Sark' },
      { label: 'Farmhouse', address: 'Demo Farm, Rue du Demo, Sark' },
    ],
    contacts: [
      { name: 'Alex Example', role: 'bill_payer', email: 'accounts@demo-farm.example' },
      { name: 'Sam Sample', role: 'site_contact', phone: '07781 100002', siteIndex: 0 },
    ],
  });
  const cottage = await post('/customers', {
    name: 'Harbour View Cottage',
    email: 'owner@harbour-view.example',
    phone: '07781 100003',
    markupBp: 11000,
    sites: [{ address: 'Harbour View, Creux Harbour, Sark' }],
    contacts: [
      { name: 'Pat Owner', role: 'landlord', email: 'owner@harbour-view.example' },
      { name: 'Chris Renter', role: 'tenant', phone: '07781 100004', siteIndex: 0 },
      { name: 'Island Lettings (demo)', role: 'agent', email: 'lets@island-lettings.example' },
    ],
  });
  const cafe = await post('/customers', {
    name: 'The Avenue Café',
    phone: '01481 830005',
    email: 'hello@avenue-cafe.example',
    sites: [{ address: 'The Avenue, Sark' }],
  });
  const hotel = await post('/customers', {
    name: 'Coupée View Hotel',
    email: 'manager@coupee-view.example',
    phone: '01481 830006',
    sites: [
      { label: 'Main building', address: 'Coupée View Hotel, Little Sark' },
      { label: 'Staff cottages', address: 'Coupée View Cottages, Little Sark' },
    ],
    contacts: [
      { name: 'Morgan Manager', role: 'site_contact', phone: '07781 100007', siteIndex: 0 },
    ],
  });
  const chapel = await post('/customers', {
    name: 'Seigneurie Gardens Trust',
    email: 'office@gardens-trust.example',
    sites: [{ label: 'Glasshouse', address: 'Seigneurie Gardens, Sark' }],
  });
  await post('/customers', {
    name: 'Robin Islander',
    phone: '07781 100008',
    sites: [{ address: 'La Ville Roussel, Sark' }],
  });
  await post('/customers', { name: 'Taylor Visitor', email: 'taylor@visitor.example' });

  // Q-0001: accepted with one extra, converted to job 122.
  const q1 = await post('/quotes', {
    customerId: farm.id,
    siteId: farm.sites[0].id,
    title: 'Barn rewire and LED lighting',
    notes:
      'Price includes testing and certificate. Please confirm any options that you would like.',
    lines: [
      { kind: 'labour', description: 'Strip out, first fix, second fix and test', qtyMilli: 24000 },
      {
        kind: 'material',
        description: '2.5mm twin & earth (m)',
        qtyMilli: 100000,
        unitCostPence: 95,
      },
      { kind: 'material', description: 'LED batten 5ft IP65', qtyMilli: 8000, unitCostPence: 2650 },
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
      {
        kind: 'material',
        description: 'Twin outdoor socket IP66',
        unitCostPence: 3800,
        optionLabel: 'Outdoor socket',
      },
      {
        kind: 'labour',
        description: 'Fit outdoor socket',
        qtyMilli: 1000,
        optionLabel: 'Outdoor socket',
      },
    ],
  });
  await post(`/quotes/${q1.id}/send`);
  await post(`/quotes/${q1.id}/accept`, { acceptedOptions: ['Yard floodlight'] });
  const job122 = await post(`/quotes/${q1.id}/convert`);
  await patch(`/jobs/${job122.id}`, { status: 'in_progress' });

  // Q-0002: sent, waiting on the customer.
  const q2 = await post('/quotes', {
    customerId: cottage.id,
    siteId: cottage.sites[0].id,
    title: 'Extra sockets in kitchen',
    lines: [
      { kind: 'labour', description: 'Install 3 double sockets on new radial', qtyMilli: 4000 },
      { kind: 'material', description: 'Double socket, white', qtyMilli: 3000, unitCostPence: 450 },
      {
        kind: 'material',
        description: '2.5mm twin & earth (m)',
        qtyMilli: 20000,
        unitCostPence: 95,
      },
    ],
  });
  await post(`/quotes/${q2.id}/send`);

  // Q-0003: draft being priced.
  await post('/quotes', {
    customerId: farm.id,
    siteId: farm.sites[1].id,
    title: 'EV charger',
    notes: 'Subject to supply check.',
    lines: [
      { kind: 'material', description: '7kW EV charger, tethered', unitCostPence: 52000 },
      { kind: 'labour', description: 'Install, test and commission', qtyMilli: 6000 },
      { kind: 'pc_sum', description: 'Allowance for groundworks', unitCostPence: 25000 },
    ],
  });

  // Q-0004: revised (rev B) after the customer asked for changes.
  const q4 = await post('/quotes', {
    customerId: hotel.id,
    siteId: hotel.sites[0].id,
    title: 'Dining room lighting upgrade',
    lines: [
      {
        kind: 'material',
        description: 'LED downlight, dimmable',
        qtyMilli: 18000,
        unitCostPence: 1450,
      },
      { kind: 'material', description: 'Smart dimmer module', qtyMilli: 3000, unitCostPence: 6200 },
      { kind: 'labour', description: 'Install downlights and dimmers', qtyMilli: 14000 },
    ],
  });
  await post(`/quotes/${q4.id}/send`);
  await post(`/quotes/${q4.id}/revise`);
  await patch(`/quotes/${q4.id}`, {
    lines: [
      {
        kind: 'material',
        description: 'LED downlight, dimmable',
        qtyMilli: 12000,
        unitCostPence: 1450,
      },
      { kind: 'material', description: 'Smart dimmer module', qtyMilli: 2000, unitCostPence: 6200 },
      { kind: 'labour', description: 'Install downlights and dimmers', qtyMilli: 10000 },
      { kind: 'carriage', description: 'Carriage', unitPricePence: 2500 },
    ],
  });

  // Q-0005: declined.
  const q5 = await post('/quotes', {
    customerId: cafe.id,
    title: 'Outdoor festoon lighting',
    lines: [
      {
        kind: 'material',
        description: 'Festoon kit 20m IP65',
        qtyMilli: 2000,
        unitCostPence: 8900,
      },
      { kind: 'labour', description: 'Install festoon and outdoor supply', qtyMilli: 5000 },
    ],
  });
  await post(`/quotes/${q5.id}/send`);
  await post(`/quotes/${q5.id}/decline`);

  // Q-0006: accepted, ready to turn into a job.
  const q6 = await post('/quotes', {
    customerId: chapel.id,
    siteId: chapel.sites[0].id,
    title: 'Glasshouse heating supply',
    lines: [
      { kind: 'labour', description: 'New 20A supply to glasshouse', qtyMilli: 7000 },
      { kind: 'material', description: '4mm SWA cable (m)', qtyMilli: 35000, unitCostPence: 410 },
      { kind: 'material', description: 'IP65 isolator and enclosure', unitCostPence: 3600 },
    ],
  });
  await post(`/quotes/${q6.id}/send`);
  await post(`/quotes/${q6.id}/accept`, { acceptedOptions: [] });

  // Call-outs without a quote.
  await post('/jobs', {
    customerId: cottage.id,
    siteId: cottage.sites[0].id,
    title: 'Call-out: RCD keeps tripping',
  });
  const j = await post('/jobs', {
    customerId: cafe.id,
    siteId: cafe.sites[0].id,
    title: 'Replace faulty extractor fan',
  });
  await patch(`/jobs/${j.id}`, { status: 'scheduled' });
  const done = await post('/jobs', {
    customerId: hotel.id,
    siteId: hotel.sites[1].id,
    title: 'Annual PAT testing',
    placeOfWork: 'sark',
  });
  await patch(`/jobs/${done.id}`, { status: 'completed' });
  await post('/jobs', {
    customerId: farm.id,
    title: 'Fault find: barn lights flickering',
    placeOfWork: 'sark',
  });
}
