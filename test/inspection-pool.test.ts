import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vite-plus/test';
import { inspectItems } from '../src/inspection-pool.ts';

describe('bounded inspections', () => {
  it('bounds inspections by available CPUs and eight while returning input order', async () => {
    const items = Array.from({ length: 37 }, (_, index) => index);
    let active = 0;
    let peak = 0;
    const result = await inspectItems(items, async index => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return `item-${index}`;
    });
    expect(result).toStrictEqual(items.map(index => `item-${index}`));
    expect(peak).toBe(Math.min(8, availableParallelism()));
    expect(active).toBe(0);
  });

  it('does not allocate workers for an empty collection', async () => {
    let inspected = false;
    const result = await inspectItems([], async () => {
      inspected = true;
      await Promise.resolve();
    });
    expect(result).toStrictEqual([]);
    expect(inspected).toBeFalsy();
  });

  it('propagates a failed inspection rather than inventing a result', async () => {
    await expect(
      inspectItems([1], async () => {
        await Promise.resolve();
        throw new Error('inspection failed');
      }),
    ).rejects.toThrow('inspection failed');
  });
});
