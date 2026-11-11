/**
 * Renders a BusinessDocument to PDF with pdf-lib: pure JavaScript, so the same code runs in a
 * Cloudflare Worker (server-side PDFs) and in the browser (the offline/demo preview). A4, built-in
 * Helvetica, no vendor footer. Long documents flow onto more pages with the table heading repeated.
 */
import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { logoBytes } from './settings';
import type { BusinessDocument, DocSection } from './documents';

const A4: [number, number] = [595.28, 841.89];
const M = 48; // margin
const INK = rgb(0.11, 0.11, 0.12);
const MUTED = rgb(0.43, 0.43, 0.46);
const RULE = rgb(0.85, 0.85, 0.87);
const BRAND = rgb(0, 0.4, 0.8);
const FILL = rgb(0.96, 0.96, 0.97);

// Characters Helvetica (WinAnsi) can draw beyond Latin-1.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const REPLACE: Record<string, string> = { '→': '->', '←': '<-', '×': 'x', '≈': '~', '✓': 'v' };

/** Makes text drawable with the built-in fonts (anything else becomes a close ASCII or "?"). */
export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (ch === '\t') out += ' ';
    else if (
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_EXTRA.has(ch)
    )
      out += ch;
    else if (REPLACE[ch]) out += REPLACE[ch];
    else if (code < 0x20) continue;
    else out += '?';
  }
  // '×' is Latin-1 (0xD7) so it survives above; keep REPLACE for fonts without it.
  return out;
}

export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of pdfSafe(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      // A single word wider than the column is broken by characters.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--;
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      line = w;
    }
    lines.push(line);
  }
  return lines;
}

interface Ctx {
  pdf: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  doc: BusinessDocument;
  logo: PDFImage | null;
}

function text(
  c: Ctx,
  s: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; right?: boolean } = {},
) {
  const size = opts.size ?? 9.5;
  const font = opts.bold ? c.bold : c.regular;
  const safe = pdfSafe(s);
  const dx = opts.right ? font.widthOfTextAtSize(safe, size) : 0;
  c.page.drawText(safe, { x: x - dx, y, size, font, color: opts.color ?? INK });
}

function newPage(c: Ctx) {
  c.page = c.pdf.addPage(A4);
  c.y = A4[1] - M;
  watermark(c);
  // Continuation pages carry a slim header so a loose page is still identifiable.
  text(c, `${c.doc.title} ${c.doc.number} · ${c.doc.business.name}`, M, c.y, {
    size: 8.5,
    color: MUTED,
  });
  c.y -= 22;
}

function ensure(c: Ctx, height: number, onBreak?: () => void) {
  if (c.y - height < M + 24) {
    newPage(c);
    onBreak?.();
  }
}

function watermark(c: Ctx) {
  if (!c.doc.draftLabel) return;
  const label = c.doc.draftLabel.split(':')[0]!.toUpperCase();
  c.page.drawText(label, {
    x: 150,
    y: 300,
    size: 96,
    font: c.bold,
    color: rgb(0.9, 0.9, 0.92),
    rotate: degrees(35),
  });
}

const COL = { qty: 380, rate: 460, amount: A4[0] - M };
const DESC_W = COL.qty - 60 - M;

function tableHead(c: Ctx, s: DocSection) {
  text(c, s.qtyLabel, COL.qty, c.y, { size: 8, color: MUTED, right: true, bold: true });
  text(c, 'Rate', COL.rate, c.y, { size: 8, color: MUTED, right: true, bold: true });
  text(c, 'Amount', COL.amount, c.y, { size: 8, color: MUTED, right: true, bold: true });
  c.y -= 6;
  c.page.drawLine({
    start: { x: M, y: c.y },
    end: { x: COL.amount, y: c.y },
    color: RULE,
    thickness: 0.8,
  });
  c.y -= 13;
}

function drawSection(c: Ctx, s: DocSection) {
  ensure(c, 60);
  text(c, s.title, M, c.y, { size: 11, bold: true });
  if (s.optional) {
    const w = c.bold.widthOfTextAtSize(pdfSafe(s.title), 11);
    text(c, 'not included in the total', M + w + 8, c.y, { size: 8.5, color: MUTED });
  }
  tableHead(c, s);
  for (const r of s.rows) {
    const desc = wrapText(r.description, c.regular, 9.5, DESC_W);
    const detail = r.detail ? wrapText(r.detail, c.regular, 8, DESC_W) : [];
    const h = desc.length * 12 + detail.length * 10 + 6;
    ensure(c, h, () => {
      text(c, `${s.title} (continued)`, M, c.y, { size: 11, bold: true });
      tableHead(c, s);
    });
    const top = c.y;
    desc.forEach((line, i) => text(c, line, M, top - i * 12));
    detail.forEach((line, i) =>
      text(c, line, M, top - desc.length * 12 - i * 10 + 1, { size: 8, color: MUTED }),
    );
    text(c, r.qty, COL.qty, top, { right: true });
    text(c, r.rate, COL.rate, top, { right: true });
    text(c, r.amount, COL.amount, top, { right: true });
    c.y = top - h;
    c.page.drawLine({
      start: { x: M, y: c.y + 8 },
      end: { x: COL.amount, y: c.y + 8 },
      color: FILL,
      thickness: 0.6,
    });
  }
  text(c, `${s.title} total`, COL.rate, c.y, { size: 9, color: MUTED, right: true });
  text(c, s.total, COL.amount, c.y, { size: 9.5, bold: true, right: true });
  c.y -= 26;
}

function drawHeader(c: Ctx) {
  const d = c.doc;
  const top = A4[1] - M;
  // Logo: the uploaded logo (fitted in a 76 x 48 box), else the initials in a brand square.
  let textX = M + 56;
  if (c.logo) {
    const k = Math.min(76 / c.logo.width, 48 / c.logo.height);
    const w = c.logo.width * k;
    const h = c.logo.height * k;
    c.page.drawImage(c.logo, { x: M, y: top - h + 4, width: w, height: h });
    textX = M + w + 12;
  } else {
    c.page.drawRectangle({ x: M, y: top - 40, width: 44, height: 44, color: BRAND });
    const ini = pdfSafe(d.business.initials);
    const iniSize = ini.length > 2 ? 15 : 18;
    text(c, ini, M + 22 - c.bold.widthOfTextAtSize(ini, iniSize) / 2, top - 24, {
      size: iniSize,
      bold: true,
      color: rgb(1, 1, 1),
    });
  }
  let y = top - 4;
  text(c, d.business.name, textX, y, { size: 14, bold: true });
  y -= 14;
  const contact = [...d.business.addressLines];
  if (d.business.email) contact.push(d.business.email);
  if (d.business.phone) contact.push(d.business.phone);
  for (const line of contact) {
    text(c, line, textX, y, { size: 9, color: MUTED });
    y -= 11.5;
  }
  if (d.business.legalName) {
    text(c, d.business.legalName, textX, y, { size: 8, color: MUTED });
    y -= 11;
  }
  // Right: title, number, dates.
  const R = A4[0] - M;
  text(c, d.title.toUpperCase(), R, top - 8, { size: 22, bold: true, color: BRAND, right: true });
  text(c, d.number, R, top - 26, { size: 12, bold: true, right: true });
  let ry = top - 42;
  if (d.draftLabel) {
    text(c, d.draftLabel, R, ry, { size: 9, bold: true, color: rgb(0.75, 0.35, 0), right: true });
    ry -= 13;
  }
  for (const m of d.meta) {
    text(c, m.value, R, ry, { size: 9, right: true });
    text(c, m.label, R - 90, ry, { size: 9, color: MUTED, right: true });
    ry -= 12;
  }
  c.y = Math.min(y, ry, top - 48) - 18;
  c.page.drawLine({
    start: { x: M, y: c.y + 6 },
    end: { x: R, y: c.y + 6 },
    color: RULE,
    thickness: 0.8,
  });
  c.y -= 12;

  // Bill to / job blocks.
  const colW = (R - M - 24) / 2;
  const blockTop = c.y;
  text(c, d.kind === 'quote' ? 'Prepared for' : 'Bill to', M, blockTop, {
    size: 8,
    bold: true,
    color: MUTED,
  });
  let ly = blockTop - 14;
  text(c, d.billTo.name, M, ly, { size: 10.5, bold: true });
  ly -= 13;
  for (const line of d.billTo.lines.flatMap((l) => wrapText(l, c.regular, 9, colW))) {
    text(c, line, M, ly, { size: 9 });
    ly -= 11.5;
  }
  const X2 = M + colW + 24;
  text(c, d.kind === 'quote' ? 'Work' : 'Job', X2, blockTop, { size: 8, bold: true, color: MUTED });
  let ry2 = blockTop - 14;
  for (const line of wrapText(d.jobTitle, c.bold, 10.5, colW)) {
    text(c, line, X2, ry2, { size: 10.5, bold: true });
    ry2 -= 13;
  }
  for (const line of d.siteLines.flatMap((l) => wrapText(l, c.regular, 9, colW))) {
    text(c, line, X2, ry2, { size: 9 });
    ry2 -= 11.5;
  }
  c.y = Math.min(ly, ry2) - 16;
}

function drawTotals(c: Ctx) {
  const d = c.doc;
  ensure(c, d.totals.length * 16 + 10);
  const R = A4[0] - M;
  for (const t of d.totals) {
    if (t.strong) {
      c.page.drawLine({
        start: { x: 330, y: c.y + 11 },
        end: { x: R, y: c.y + 11 },
        color: RULE,
        thickness: 0.8,
      });
    }
    text(c, t.label, COL.rate, c.y, {
      size: t.strong ? 11 : 9.5,
      bold: t.strong,
      right: true,
      color: t.strong ? INK : MUTED,
    });
    text(c, t.value, R, c.y, { size: t.strong ? 11 : 9.5, bold: t.strong, right: true });
    c.y -= t.strong ? 18 : 14;
  }
  c.y -= 10;
}

function drawFooterBlocks(c: Ctx) {
  const d = c.doc;
  const width = A4[0] - 2 * M;
  if (d.payment) {
    ensure(c, 70);
    const h = 58;
    c.page.drawRectangle({ x: M, y: c.y - h + 12, width, height: h, color: FILL });
    text(c, 'How to pay', M + 10, c.y, { size: 9, bold: true });
    const rows = [
      ['Account name', d.payment.accountName],
      ['Sort code', d.payment.sortCode],
      ['Account number', d.payment.accountNumber],
      ['Reference', d.payment.reference],
    ];
    rows.forEach(([k, v], i) => {
      const x = M + 10 + (i % 2) * (width / 2);
      const y = c.y - 16 - Math.floor(i / 2) * 13;
      text(c, k!, x, y, { size: 9, color: MUTED });
      text(c, v!, x + 80, y, { size: 9, bold: i === 3 });
    });
    c.y -= h + 10;
  }
  for (const [title, body] of [
    ['Notes', d.notes],
    ['Terms', d.terms],
  ] as const) {
    if (!body) continue;
    const lines = wrapText(body, c.regular, 8.5, width);
    ensure(c, 16 + Math.min(lines.length, 4) * 11);
    text(c, title, M, c.y, { size: 9, bold: true });
    c.y -= 13;
    for (const line of lines) {
      ensure(c, 11);
      text(c, line, M, c.y, { size: 8.5, color: MUTED });
      c.y -= 11;
    }
    c.y -= 8;
  }
}

/** A bad or unreadable logo never stops a document: it falls back to the initials. */
async function embedLogo(pdf: PDFDocument, dataUrl: string | null | undefined) {
  const img = dataUrl ? logoBytes(dataUrl) : null;
  if (!img) return null;
  try {
    return img.mime === 'image/png' ? await pdf.embedPng(img.bytes) : await pdf.embedJpg(img.bytes);
  } catch {
    return null;
  }
}

export async function renderPdf(doc: BusinessDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${doc.title} ${doc.number}`));
  pdf.setAuthor(pdfSafe(doc.business.name));
  pdf.setCreator(pdfSafe(doc.business.name));
  pdf.setProducer(pdfSafe(doc.business.name));
  const c: Ctx = {
    pdf,
    page: pdf.addPage(A4),
    y: 0,
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    doc,
    logo: await embedLogo(pdf, doc.business.logoDataUrl),
  };
  watermark(c);
  drawHeader(c);
  for (const s of doc.sections) drawSection(c, s);
  drawTotals(c);
  drawFooterBlocks(c);
  const pages = pdf.getPages();
  if (pages.length > 1)
    pages.forEach((p, i) => {
      const label = `Page ${i + 1} of ${pages.length}`;
      p.drawText(label, {
        x: A4[0] - M - c.regular.widthOfTextAtSize(label, 8),
        y: M - 20,
        size: 8,
        font: c.regular,
        color: MUTED,
      });
    });
  return pdf.save();
}
