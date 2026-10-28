import { describe, expect, it } from 'vite-plus/test';
import { inspectCleanItems } from '../src/clean-pool.ts';

describe('bounded clean inspections', () => {
  it('keeps twelve inspections in flight and returns their input order', async () => {
    const items = Array.from({ length: 37 }, (_, index) => index);
    let active = 0;
    let peak = 0;
    const result = await inspectCleanItems(items, async index => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return `item-${index}`;
    });
    expect(result).toStrictEqual(items.map(index => `item-${index}`));
    expect(peak).toBe(12);
    expect(active).toBe(0);
  });

  it('does not allocate workers for an empty collection', async () => {
    let inspected = false;
    const result = await inspectCleanItems([], async () => {
      inspected = true;
      await Promise.resolve();
    });
    expect(result).toStrictEqual([]);
    expect(inspected).toBeFalsy();
  });

  it('propagates a failed inspection rather than inventing a result', async () => {
    await expect(
      inspectCleanItems([1], async () => {
        await Promise.resolve();
        throw new Error('inspection failed');
      }),
    ).rejects.toThrow('inspection failed');
  });
});
