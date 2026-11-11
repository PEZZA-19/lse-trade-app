/**
 * Positioned text from a PDF page, the shape pdf.js `getTextContent()` gives, rebuilt into
 * lines of cells. Pure, so it runs in Workers, the browser and tests alike. The pdf.js call
 * itself lives in `../pdftext.ts` so the API bundle never pulls pdf.js in.
 */

/** One run of text in top-down page coordinates (points). */
export type TextItem = { x: number; y: number; width: number; height: number; str: string };

/** Words that sit close together on a line, e.g. "Order Number: STOCK". */
export type Cell = { x0: number; x1: number; text: string };

export type Line = { y: number; cells: Cell[]; /** Cells joined by two spaces. */ text: string };

export type PageText = { number: number; width: number; height: number; lines: Line[] };

/** Same baseline within this many points. Mixed 7pt/8pt runs sit up to ~2pt apart. */
const SAME_LINE = 2.5;

/** Groups items into lines (top to bottom) and words into cells (left to right). */
export function linesFromItems(items: TextItem[]): Line[] {
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: TextItem[][] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(it.y - g[0]!.y) <= SAME_LINE) g.push(it);
    else groups.push([it]);
  }
  return groups.map((g) => {
    g.sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const it of g) {
      const text = it.str.replace(/\s+/g, ' ').trim();
      const last = cells[cells.length - 1];
      // A gap wider than about a space and a half starts a new column.
      const gap = Math.max(5.5, it.height * 0.62);
      if (last && it.x - last.x1 <= gap) {
        last.text += ` ${text}`;
        last.x1 = Math.max(last.x1, it.x + it.width);
      } else cells.push({ x0: it.x, x1: it.x + it.width, text });
    }
    const y = g.reduce((t, i) => t + i.y, 0) / g.length;
    return { y, cells, text: cells.map((c) => c.text).join('  ') };
  });
}

/** Plain text of pages, for display and for the AI helper. */
export function pagesToText(pages: PageText[]): string {
  return pages.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n\f\n');
}
