import { linesFromItems, type PageText, type TextItem } from './billread/text';

type Matrix = [number, number, number, number, number, number];
const multiply = (a: Matrix, b: number[]): Matrix => [
  a[0] * b[0]! + a[2] * b[1]!,
  a[1] * b[0]! + a[3] * b[1]!,
  a[0] * b[2]! + a[2] * b[3]!,
  a[1] * b[2]! + a[3] * b[3]!,
  a[0] * b[4]! + a[2] * b[5]! + a[4],
  a[1] * b[4]! + a[3] * b[5]! + a[5],
];

/**
 * Text of every page via pdf.js (the serverless build from `unpdf`: no worker, no canvas),
 * so it runs in Cloudflare Workers and the browser. Coordinates go through the page
 * viewport, so rotated pages (statements printed landscape) read left to right.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<PageText[]> {
  const { getDocumentProxy } = await import('unpdf');
  // pdf.js takes ownership of the buffer; keep the caller's copy intact.
  const pdf = await getDocumentProxy(bytes.slice());
  try {
    const pages: PageText[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: TextItem[] = [];
      for (const raw of content.items) {
        if (!('str' in raw) || !raw.str.trim()) continue;
        const t = multiply(vp.transform as Matrix, raw.transform as number[]);
        items.push({ x: t[4], y: t[5], width: raw.width, height: raw.height, str: raw.str });
      }
      pages.push({ number: n, width: vp.width, height: vp.height, lines: linesFromItems(items) });
    }
    return pages;
  } finally {
    await pdf.cleanup?.();
  }
}
