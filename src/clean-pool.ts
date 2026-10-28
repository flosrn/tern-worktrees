/** Examines at most twelve branches or worktrees at once and returns decisions in input order. */
export const inspectCleanItems = async <Item, Result>(items: Item[], inspect: (item: Item) => Promise<Result>): Promise<Result[]> => {
  const results: Result[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(12, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        // A worker starts its next inspection only after the previous one finishes.
        // eslint-disable-next-line no-await-in-loop
        results[index] = await inspect(items[index]);
      }
    }),
  );
  return results;
};
