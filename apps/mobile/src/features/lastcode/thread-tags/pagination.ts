// Pages are request-local and discarded when the query or environment changes.
export async function collectTagPages<T>(
  read: (
    cursor: number | undefined,
  ) => Promise<{ readonly items: readonly T[]; readonly nextCursor: number | null }>,
  active: () => boolean,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: number | undefined;
  do {
    const page = await read(cursor);
    if (!active()) return [];
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (cursor !== undefined && page.nextCursor <= cursor)
      throw new Error("Tag pagination did not advance.");
    cursor = page.nextCursor;
  } while (active());
  return [];
}
