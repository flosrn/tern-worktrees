import { availableParallelism } from 'node:os';

/** Examines at most eight items, and no more than the available processors, at once. Returns results in input order. */
export const inspectItems = async <Item, Result>(items: Item[], inspect: (item: Item) => Promise<Result>): Promise<Result[]> => {
  const results: Result[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, availableParallelism(), items.length) }, async () => {
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
