/**
 * Fictional demo data, used to seed the local dev database and the static preview build.
 * Every name, address, phone and email here is made up. No real customer data.
 * It drives the public API (POST only), so it exercises the same rules as real use.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Post = (path: string, body?: unknown) => Promise<any>;
type Patch = (path: string, body: unknown) => Promise<any>;
type Get = (path: string) => Promise<any>;
/** `minutes` ago, as ISO (never in the future, whatever time the seed runs). */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** ISO time `days` from today at `hour`:00 local time (demo appointments stay current). */
const at = (days: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

export async function runDemoScript(post: Post, patch: Patch, get?: Get): Promise<void> {
  const members: { userId: string; name: string; role: string }[] = get
    ? await get('/members')
    : [];
  const joe = members.find((m) => m.role === 'owner')?.userId;
  const sam = members.find((m) => m.role === 'staff')?.userId;
  const assign = async (jobId: string, userId: string | undefined) =>
    userId && post(`/jobs/${jobId}/assignees`, { userId });
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
  // Joe assigned (automatic: Assigned), booked in for today (automatic: Booked in). The timer is
  // started at the end (one timer per person).
  await assign(job122.id, joe);
  await post(`/jobs/${job122.id}/appointments`, {
    startsAt: at(0, 8),
    endsAt: at(0, 17),
    userId: joe,
  });
  await post(`/jobs/${job122.id}/appointments`, {
    startsAt: at(1, 8),
    endsAt: at(1, 13),
    userId: joe,
  });

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
  await assign(j.id, sam);
  await post(`/jobs/${j.id}/appointments`, { startsAt: at(2, 9), endsAt: at(2, 12), userId: sam });
  const done = await post('/jobs', {
    customerId: hotel.id,
    siteId: hotel.sites[1].id,
    title: 'Annual PAT testing',
    placeOfWork: 'sark',
  });
  // Done yesterday: booked, timed on site (a timesheet entry), then invoiced by hand.
  await assign(done.id, joe);
  await post(`/jobs/${done.id}/appointments`, {
    startsAt: at(-1, 9),
    endsAt: at(-1, 13),
    userId: joe,
  });
  await post(`/jobs/${done.id}/timer/start`, { at: at(-1, 9) });
  await post(`/jobs/${done.id}/timer/stop`, { at: at(-1, 12) });
  await patch(`/jobs/${done.id}`, { stageKey: 'to_invoice' });
  await patch(`/jobs/${done.id}`, { stageKey: 'complete' });
  // A custom stage, as a business might add in Settings.
  const waiting = await post('/job-stages', { name: 'Waiting on parts', colour: 'teal' });
  const fault = await post('/jobs', {
    customerId: farm.id,
    title: 'Fault find: barn lights flickering',
    placeOfWork: 'sark',
  });
  await patch(`/jobs/${fault.id}`, { stageId: waiting.id });
  // Parts due Friday-ish: booking it in doesn't override a custom stage.
  await post(`/jobs/${fault.id}/appointments`, {
    startsAt: at(3, 14),
    endsAt: at(3, 16),
    userId: sam,
  });
  // Fictional bank details so invoices can be approved in the demo.
  await patch('/settings', {
    bankAccountName: 'Little Sark Electric (demo)',
    bankSortCode: '112233',
    bankAccountNumber: '12345678',
  });

  // Price list, imported from a supplier-style CSV (fictional merchants).
  await post('/price-list/import', {
    apply: true,
    csv: [
      'Code,Description,Unit,Supplier,Cost,Markup,Sell',
      'TE25,2.5mm twin & earth cable,m,Island Electrical (demo),0.98,,',
      'TE15,1.5mm twin & earth cable,m,Island Electrical (demo),0.72,,',
      'SKT2,Double switched socket,each,Island Electrical (demo),3.10,50%,',
      'BB35,Flush back box 35mm,each,Sarnia Wholesale (demo),0.55,,1.25',
      'GRM,Grommets (pack of 10),pack,Sarnia Wholesale (demo),1.20,,',
      'RCBO32,RCBO 32A Type A,each,Island Electrical (demo),18.40,,',
      'PIR1,LED floodlight with PIR,each,Sarnia Wholesale (demo),24.00,40%,',
      'JB20,Weatherproof junction box,each,Sarnia Wholesale (demo),4.60,,',
      'SWA4,4mm 3-core SWA cable,m,Island Electrical (demo),4.10,,',
      'GLD20,20mm SWA gland kit,each,Sarnia Wholesale (demo),2.35,,',
    ].join('\n'),
  });
  const items: { id: string; code: string }[] = get ? await get('/price-list') : [];
  const code = (c: string) => items.find((i) => i.code === c)?.id;
  const kitLines = (pairs: [string, number][]) =>
    pairs.filter(([c]) => code(c)).map(([c, qty]) => ({ itemId: code(c)!, qtyMilli: qty }));
  const socketKit = await post('/kits', {
    name: 'Double socket on new radial',
    description: 'Per socket: cable run, socket, back box and grommets.',
    lines: kitLines([
      ['TE25', 12000],
      ['SKT2', 1000],
      ['BB35', 1000],
      ['GRM', 1000],
    ]),
  });
  await post('/kits', {
    name: 'Outside light with PIR',
    lines: kitLines([
      ['PIR1', 1000],
      ['JB20', 1000],
      ['TE15', 8000],
    ]),
  });
  // A draft quote using the socket kit as one costed block (x4).
  if (socketKit?.lines) {
    await post('/quotes', {
      customerId: cafe.id,
      siteId: cafe.sites[0].id,
      title: 'Extra kitchen sockets',
      lines: [
        {
          kind: 'material',
          description: socketKit.name,
          qtyMilli: 4000,
          unitCostPence: socketKit.costPence,
          unitPricePence: socketKit.sellPence,
          kit: {
            kitId: socketKit.id,
            name: socketKit.name,
            costPence: socketKit.costPence,
            sellPence: socketKit.sellPence,
            components: socketKit.lines.map((l: any) => ({
              itemId: l.itemId,
              code: l.code,
              description: l.description,
              unit: l.unit,
              qtyMilli: l.qtyMilli,
              unitCostPence: l.unitCostPence,
              unitSellPence: l.unitSellPence,
            })),
          },
        },
        { kind: 'labour', description: 'First fix, second fix and test', qtyMilli: 5000 },
      ],
    });
  }
  // The merchant put cable up: the kit recalculates (old and new cost shown); the draft quote
  // keeps its block until Joe chooses to update it.
  if (code('TE25')) await patch(`/price-list/${code('TE25')}`, { unitCostPence: 112 });

  // Invoices. Job 122: a 30% deposit, approved, sent and paid; the remainder is a draft.
  const dep = await post(`/jobs/${job122.id}/invoices`, {
    source: 'quote',
    mode: 'percent',
    percentBp: 3000,
  });
  await post(`/invoices/${dep.id}/approve`);
  await post(`/invoices/${dep.id}/mark-sent`);
  await post(`/invoices/${dep.id}/payments`, {
    amountPence: dep.totalPence,
    paidOn: ago(60 * 24).slice(0, 10),
    method: 'bank_transfer',
    reference: 'DEMO FARM DEP',
  });
  await post(`/jobs/${job122.id}/invoices`, { source: 'quote', mode: 'remainder' });
  // PAT testing: time and materials from yesterday's timer entry, sent and awaiting payment.
  const pat = await post(`/jobs/${done.id}/invoices`, { source: 'job' });
  await post(`/invoices/${pat.id}/approve`);
  await post(`/invoices/${pat.id}/mark-sent`);
  await post(`/invoices/${pat.id}/payments`, {
    amountPence: 5000,
    paidOn: ago(0).slice(0, 10),
    method: 'card',
  });

  // On site at the barn now: starting the timer moves job 122 to In Progress (automatic).
  await post(`/jobs/${job122.id}/timer/start`, { at: ago(95) });
}
