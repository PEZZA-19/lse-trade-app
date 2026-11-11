/** Side-by-side columns for overlapping appointments within one day (like Apple Calendar). */
export interface Placed<T> {
  item: T;
  col: number;
  cols: number;
}

export function layoutDay<T extends { startsAt: string; endsAt: string }>(items: T[]): Placed<T>[] {
  const sorted = [...items].sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || b.endsAt.localeCompare(a.endsAt),
  );
  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let clusterEnd = '';
  const close = () => {
    const cols = Math.max(1, ...cluster.map((p) => p.col + 1));
    for (const p of cluster) p.cols = cols;
    cluster = [];
  };
  for (const item of sorted) {
    if (cluster.length && item.startsAt >= clusterEnd) close();
    // First column whose last item has ended.
    const used = new Map<number, string>();
    for (const p of cluster) {
      const end = used.get(p.col);
      if (!end || p.item.endsAt > end) used.set(p.col, p.item.endsAt);
    }
    let col = 0;
    while (used.has(col) && used.get(col)! > item.startsAt) col++;
    const placed = { item, col, cols: 1 };
    cluster.push(placed);
    out.push(placed);
    if (item.endsAt > clusterEnd) clusterEnd = item.endsAt;
  }
  if (cluster.length) close();
  return out;
}
