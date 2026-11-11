/**
 * Synthetic merchant PDFs laid out like the real CEF, DOCI and CI Lighting documents
 * (positions taken from them), with made-up customers, accounts and references. These are
 * what git holds; the real PDFs never enter the repo.
 *
 * Regenerate the .pdf copies with: WRITE_FIXTURES=1 pnpm --filter @lse/shared test
 */
import { degrees, PDFDocument, type PDFFont, type PDFPage, StandardFonts } from 'pdf-lib';

type Draw = (
  x: number,
  yTop: number,
  text: string,
  size?: number,
  align?: 'left' | 'right',
) => void;

async function doc() {
  const pdf = await PDFDocument.create();
  pdf.setProducer('LSE synthetic fixture');
  pdf.setCreationDate(new Date('2026-11-11T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-11-11T00:00:00Z'));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  return { pdf, font };
}

/** Portrait A4, top-down coordinates. */
function portrait(page: PDFPage, font: PDFFont): Draw {
  const h = page.getHeight();
  return (x, yTop, text, size = 8, align = 'left') => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: align === 'right' ? x - w : x, y: h - yTop, size, font });
  };
}

/** A4 stored portrait with /Rotate 90, read landscape: how the CI Lighting statement is printed. */
function landscape(page: PDFPage, font: PDFFont): Draw {
  page.setRotation(degrees(90));
  return (x, yTop, text, size = 10.1, align = 'left') => {
    const w = font.widthOfTextAtSize(text, size);
    const X = align === 'right' ? x - w : x;
    // Display (X, Y) is page (Y, X); text runs up the page so it reads left to right.
    page.drawText(text, { x: yTop, y: X, size, font, rotate: degrees(90) });
  };
}

/* ---------------------------------- CEF ---------------------------------- */

export type CefLine = {
  qty: number;
  item: string;
  desc: string[];
  price: string;
  per: string;
  disc?: string;
  goods: string;
};
export type CefInvoice = {
  number: string;
  date: string;
  order: string;
  lines: CefLine[];
  goods: string;
  total?: string;
};

function cefPage(page: PDFPage, font: PDFFont, inv: CefInvoice) {
  const t = portrait(page, font);
  const Y = (pdfY: number) => 841.89 - pdfY;
  t(191.1, Y(817.8), 'C.E.F. (Guernsey) Limited', 7);
  t(191.1, Y(809.9), 'Demo Building, Example Industrial Estate,', 7);
  t(191.1, Y(802.0), 'St Sampsons, Guernsey, GY0 0AA.', 7);
  t(191.1, Y(794.0), 'Phone:', 7);
  t(242.9, Y(794.0), '01481 000 000', 7);
  t(191.1, Y(786.1), 'Email:', 7);
  t(242.9, Y(786.1), 'sales@example.test', 7);
  t(475.9, Y(794.3), 'INVOICE', 12);
  t(402.0, Y(771.8), 'Invoice:');
  t(478.5, Y(771.8), inv.number);
  t(375.6, Y(730.3), 'Tax Point Date:');
  t(476.8, Y(730.3), inv.date);
  t(491.2, Y(721.2), 'Page 1/1');
  t(52.7, Y(716.7), 'DEMO CUSTOMER', 9);
  t(385.2, Y(712.2), 'Account Code:');
  t(491.2, Y(712.2), '99990000');
  t(52.7, Y(706.5), '1 EXAMPLE LANE', 9);
  t(525.0, Y(703.1), `Order Number: ${inv.order}`, 8, 'right');
  t(52.7, Y(696.3), 'LITTLE SARK (FICTIONAL)', 9);
  t(52.7, Y(655.5), 'GY0 0ZZ', 9);
  t(
    35.4,
    Y(570.0),
    'Payment to: Demo Building, Example Industrial Estate, St Sampsons, Guernsey, GY0 0AA',
    5,
  );
  const disc = inv.lines.some((l) => l.disc);
  t(33.7, Y(559.4), 'Qty');
  t(54.1, Y(559.4), 'Item');
  t(202.4, Y(559.4), 'Description');
  t(385.2, Y(559.4), '£ Price');
  t(424.9, Y(559.2), 'Per', 7);
  if (disc) t(447.3, Y(559.4), 'Discount');
  t(535.4, Y(559.4), '£Goods', 8, 'right');
  let y = Y(539.8);
  for (const l of inv.lines) {
    t(48.2, y, String(l.qty), 8, 'right');
    t(54.1, y, l.item, 7);
    l.desc.forEach((d, i) => t(202.4, y + i * 11.9, d));
    // The price sits on the last description line, as CEF prints it.
    const py = y + (l.desc.length - 1) * 11.9;
    t(418.9, py, l.price, 8, 'right');
    t(424.9, py, l.per, 7);
    if (l.disc) t(458.6, py, l.disc, 7);
    t(535.4, py, l.goods, 8, 'right');
    y += l.desc.length * 11.9;
  }
  const total = inv.total ?? inv.goods;
  t(20, Y(140.7), 'Z');
  t(50, Y(140.7), '0%');
  t(100, Y(140.7), `£${inv.goods}`);
  t(170, Y(140.7), '£0.00');
  t(394.0, Y(140.7), 'Goods Total:');
  t(535.4, Y(140.7), `£${inv.goods}`, 8, 'right');
  t(403.7, Y(131.6), 'VAT Total:');
  t(535.4, Y(131.6), '£0.00', 8, 'right');
  t(422.6, Y(122.6), 'Total:');
  t(535.4, Y(122.6), `£${total}`, 8, 'right');
  t(20, Y(90), 'OUR TERMS AND CONDITIONS OF SALE (COPIES OF WHICH ARE AVAILABLE ON REQUEST)', 6);
  t(20, Y(60), 'Settlement thirty days dis', 6);
}

export const CEF_INVOICES: CefInvoice[] = [
  {
    number: 'GUR/900101',
    date: '07 Nov 2026',
    order: 'DEMO HALL',
    lines: [
      {
        qty: 1,
        item: 'DEMOLITE LIGHTING WL.6W.BLK',
        desc: ['Demo 6W Led Wall Lantern', 'Black'],
        price: '26.25',
        per: 'each',
        goods: '26.25',
      },
    ],
    goods: '26.25',
  },
  {
    number: 'GUR/900102',
    date: '07 Nov 2026',
    order: 'STOCK',
    lines: [
      {
        qty: 1,
        item: 'F4P 40001',
        desc: ['Demo Spray 500ML'],
        price: '7.99',
        per: 'Each',
        goods: '7.99',
      },
      {
        qty: 10,
        item: 'F4P AA1000',
        desc: ['Demo Cells AA 10'],
        price: '0.70',
        per: 'each',
        disc: '35%',
        goods: '4.55',
      },
      {
        qty: 10,
        item: 'F4P AAA1000',
        desc: ['Demo Cells AAA'],
        price: '0.67',
        per: 'each',
        disc: '35%',
        goods: '4.36',
      },
    ],
    goods: '16.90',
  },
  {
    number: 'GUR/900151',
    date: '09 Nov 2026',
    order: 'OLD BAKERY REWIRE',
    lines: [
      {
        qty: 2,
        item: 'BELL 00001',
        desc: ['4.7W Led Dimmable Demo Candle', 'Opal -'],
        price: '3.06',
        per: 'each',
        goods: '6.12',
      },
    ],
    goods: '6.12',
  },
  {
    number: 'GUR/900152',
    date: '09 Nov 2026',
    order: 'GENERATOR LINK',
    lines: [
      {
        qty: 1,
        item: 'DEMOCRIMP G25',
        desc: ['25mm Brass Cable Gland 2 Pk'],
        price: '12.50',
        per: 'Pack',
        goods: '12.50',
      },
      {
        qty: 1,
        item: 'CTC UK DEMO-PK',
        desc: ['Brass Cable Gland Packs'],
        price: '27.30',
        per: 'Pack',
        goods: '27.30',
      },
    ],
    goods: '39.80',
  },
];

/** Four invoices, one per page, like CEF's daily invoice PDF. */
export async function cefPdf(invoices: CefInvoice[] = CEF_INVOICES): Promise<Uint8Array> {
  const { pdf, font } = await doc();
  for (const inv of invoices) cefPage(pdf.addPage([595.276, 841.89]), font, inv);
  return pdf.save({ useObjectStreams: false });
}

/* ---------------------------------- DOCI --------------------------------- */

export type DociLine = {
  code: string;
  desc: string;
  qty: string;
  rrp: string;
  price: string;
  value: string;
};
export type DociInvoice = {
  number: string;
  date: string;
  order: string;
  yourRef: string;
  lines: DociLine[];
  total: string;
  payable: string;
};

export const DOCI_INVOICE: DociInvoice = {
  number: '900530',
  date: '07/11/2026',
  order: '700543',
  yourRef: 'OLD BAKERY REWIRE',
  lines: [
    {
      code: '22999800',
      desc: 'DEMO ACTUATOR 2 PORT',
      qty: '1.00',
      rrp: '61.19',
      price: '46.62',
      value: '46.62',
    },
    {
      code: '22999100',
      desc: 'DEMO ROOM THERMOSTAT',
      qty: '2.00',
      rrp: '30.13',
      price: '19.32',
      value: '38.64',
    },
  ],
  total: '85.26',
  payable: '30/12/2026',
};

export async function dociPdf(inv: DociInvoice = DOCI_INVOICE): Promise<Uint8Array> {
  const { pdf, font } = await doc();
  const page = pdf.addPage([595.276, 841.89]);
  const t = portrait(page, font);
  const Y = (pdfY: number) => 841.89 - pdfY;
  t(42.0, Y(785.3), 'I N V O I C E', 18);
  t(48.8, Y(723.5), 'Invoice To :', 9);
  t(52.0, Y(710.9), 'DEMO CUSTOMER', 10);
  t(52.0, Y(701.1), '1 EXAMPLE LANE', 10);
  t(52.0, Y(689.2), 'LITTLE SARK (FICTIONAL)', 10);
  t(391.2, Y(710.9), 'Duquemin & Ozanne CI Ltd', 10);
  t(391.2, Y(701.1), 'Unit 0 Demo Yard');
  t(391.2, Y(689.2), 'St Sampsons');
  t(391.2, Y(677.6), 'Guernsey');
  t(391.2, Y(666.0), 'GY0 0AB');
  t(38.6, Y(619.2), 'Account');
  t(109.1, Y(619.2), 'Invoice Date');
  t(199.8, Y(619.2), 'Invoice No');
  t(276.9, Y(618.1), 'Order No');
  t(351.5, Y(619.2), 'User');
  t(411.3, Y(619.2), 'Your Reference');
  t(492.1, Y(619.2), 'Pg');
  t(505.4, Y(619.2), '1');
  t(522.1, Y(619.2), 'of');
  t(532.3, Y(619.2), '1');
  t(42.0, Y(594.2), 'DEM01', 10);
  t(109.1, Y(594.2), inv.date, 10);
  t(203.2, Y(594.2), inv.number, 10);
  t(276.9, Y(594.2), inv.order, 10);
  t(350.9, Y(594.2), 'XX', 10);
  t(411.3, Y(594.2), inv.yourRef, 10);
  t(48.8, Y(560.8), 'Code');
  t(122.5, Y(560.8), 'Description');
  t(306.4, Y(560.8), 'Quantity');
  t(374.5, Y(560.8), 'RRP');
  t(442.2, Y(560.8), 'Price');
  t(507.7, Y(560.8), 'Value');
  let y = Y(536.7);
  for (const l of inv.lines) {
    t(42.0, y, l.code, 9);
    t(95.8, y, l.desc, 9);
    t(344.1, y, l.qty, 9, 'right');
    t(399.5, y, l.rrp, 9, 'right');
    t(478.6, y, l.price, 9, 'right');
    t(545.8, y, l.value, 9, 'right');
    y += 23.6;
  }
  t(48.8, Y(162.8), 'Goods Collected by >', 9);
  t(142.6, Y(162.8), 'XX', 9);
  t(347.5, Y(152.1), 'Total Invoice Value £');
  t(512.3, Y(150.3), inv.total, 10, 'right');
  t(351.5, Y(128.8), 'Date Payable');
  t(462.0, Y(127.0), inv.payable, 10);
  t(65.5, Y(100.1), 'Please make your payment to: D&O Channel Islands Ltd. Account: 00000000', 10);
  t(436.6, Y(100.1), 'Sort Code: 00-00-00', 10);
  return pdf.save({ useObjectStreams: false });
}

/* ------------------------------ CI Lighting ------------------------------ */

export type StatementLine = {
  date: string;
  type: string;
  ref: string;
  yourRef: string;
  amount: string;
  flag: string;
  balance: string;
};

export const CI_STATEMENT: StatementLine[] = [
  {
    date: '09/07/26',
    type: 'INV',
    ref: '90058:1',
    yourRef: 'DEMO HALL',
    amount: '581.76',
    flag: '*',
    balance: '581.76',
  },
  {
    date: '23/07/26',
    type: 'INV',
    ref: '90455:1',
    yourRef: 'SHOP FIT',
    amount: '241.60',
    flag: '*',
    balance: '823.36',
  },
  {
    date: '01/09/26',
    type: 'CAS',
    ref: 'BACS',
    yourRef: '',
    amount: '802.77',
    flag: '*',
    balance: '20.59',
  },
  {
    date: '01/09/26',
    type: 'DIS',
    ref: 'BACS',
    yourRef: '',
    amount: '20.59',
    flag: '*',
    balance: '0.00',
  },
  {
    date: '03/09/26',
    type: 'INV',
    ref: '91585:1',
    yourRef: 'OLD BAKERY',
    amount: '936.01',
    flag: 'S',
    balance: '936.01',
  },
  {
    date: '03/09/26',
    type: 'INV',
    ref: '91588:1',
    yourRef: 'HARBOUR FLAT',
    amount: '84.38',
    flag: 'S',
    balance: '1020.39',
  },
  {
    date: '18/09/26',
    type: 'INV',
    ref: '92078:1',
    yourRef: 'STOCK',
    amount: '15.80',
    flag: 'S',
    balance: '1036.19',
  },
  {
    date: '29/09/26',
    type: 'CRN',
    ref: 'C9042:1',
    yourRef: 'RETURNED LAMPS',
    amount: '47.75',
    flag: 'S',
    balance: '988.44',
  },
  {
    date: '09/10/26',
    type: 'INV',
    ref: '92772:1',
    yourRef: 'DEMO COTTAGE',
    amount: '113.97',
    flag: 'S',
    balance: '1102.41',
  },
  {
    date: '28/10/26',
    type: 'CAS',
    ref: 'BACS',
    yourRef: '',
    amount: '355.26',
    flag: '',
    balance: '747.15',
  },
];

export async function ciStatementPdf(rows: StatementLine[] = CI_STATEMENT): Promise<Uint8Array> {
  const { pdf, font } = await doc();
  const page = pdf.addPage([595.276, 841.89]);
  const t = landscape(page, font);
  t(268.2, 15.1, 'CI Lighting Ltd');
  t(445.6, 24.7, 'STATEMENT', 20.2);
  t(658.0, 24.7, 'REMITTANCE ADVICE', 16);
  t(268.2, 26.4, 'Demo Warehouse');
  t(268.2, 37.9, 'St Peter Port');
  t(268.2, 50.2, 'Guernsey GY0 0AC');
  t(268.2, 61.7, 'T:');
  t(281.2, 61.7, '01481 000001');
  t(16.7, 108.0, 'DEMO CUSTOMER,');
  t(16.7, 119.5, '1 EXAMPLE LANE,');
  t(316.9, 119.5, '900');
  t(16.7, 131.0, 'LITTLE SARK (FICTIONAL),');
  t(16.7, 142.8, 'GY0 0ZZ');
  t(316.9, 142.8, '30/10/26');
  t(323.2, 177.8, '1');
  t(335.9, 177.8, 'of');
  t(354.6, 177.8, '1');
  t(648.6, 154.6, '900');
  t(648.6, 177.8, '30/10/26');
  let y = 248.2;
  for (const r of rows) {
    t(16.7, y, r.date);
    t(73.1, y, r.type);
    t(98.0, y, r.ref);
    if (r.yourRef) t(154.4, y, r.yourRef);
    t(416.7, y, r.amount, 10.1, 'right');
    if (r.flag) t(423.4, y, r.flag);
    t(548.2, y, r.balance, 10.1, 'right');
    // The remittance slip repeats every row.
    t(573.4, y, r.date);
    t(629.8, y, r.ref);
    t(742.2, y, r.amount, 10.1, 'right');
    t(810.8, y, r.balance, 10.1, 'right');
    y += 11.7;
  }
  const closing = rows[rows.length - 1]?.balance ?? '0.00';
  t(200.0, 440.0, 'Bank payments can be made to:-');
  t(60.0, 452.0, '0.00');
  t(110.0, 452.0, '0.00');
  t(150.0, 452.0, closing);
  t(200.0, 464.0, 'Please quote your account number.');
  t(400.0, 464.0, closing);
  t(780.0, 452.0, closing);
  return pdf.save({ useObjectStreams: false });
}
