/** Stable relevance ranking: exact name, prefix, substring, then detail-only.
 * Empty queries preserve the existing order. Buckets avoid sorting large catalogs.
 */
export function rankSearch<T>(
  items: readonly T[],
  query: string,
  names: (item: T) => readonly string[],
  details?: (item: T) => readonly string[],
): T[] {
  const term = query.trim().toLowerCase();
  if (!term) return [...items];
  const buckets: T[][] = [[], [], [], []];
  for (const item of items) {
    let rank = 4;
    for (const name of names(item)) {
      const text = name.toLowerCase();
      if (text === term) {
        rank = 0;
        break;
      }
      if (text.startsWith(term)) rank = Math.min(rank, 1);
      else if (text.includes(term)) rank = Math.min(rank, 2);
    }
    if (
      rank === 4 &&
      details?.(item).some((text) => text.toLowerCase().includes(term))
    )
      rank = 3;
    if (rank < 4) buckets[rank].push(item);
  }
  return buckets.flat();
}
