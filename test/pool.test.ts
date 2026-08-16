import {describe, expect, it} from 'vitest';
import {buffered, inPool} from '../src/core/pool';

describe('running several at once', () => {
  it('returns results in the order they went in, not the order they finished', async () => {
    // A report whose rows shuffle between runs cannot be diffed, and a suite you
    // cannot diff is one where a new failure hides among the reordering.
    const results = await inPool([30, 5, 20, 1], 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(results.map((r) => r.value)).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    await inPool(Array.from({length: 20}, (_, i) => i), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    });
    expect(peak).toBe(4);
  });

  it('keeps going when one worker throws', async () => {
    // One journey failing to load is not a reason to abandon the other nineteen.
    const results = await inPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('could not load');
      return n;
    });

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1].error?.message).toBe('could not load');
    expect(results[2].value).toBe(3);
  });

  it('runs everything even when the pool is wider than the work', async () => {
    const results = await inPool([1, 2], 16, async (n) => n * 2);
    expect(results.map((r) => r.value)).toEqual([2, 4]);
  });

  it('does nothing gracefully', async () => {
    expect(await inPool([], 4, async () => 1)).toEqual([]);
  });

  it('treats a limit below one as one', async () => {
    let peak = 0;
    let running = 0;
    await inPool([1, 2, 3], 0, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
    });
    expect(peak).toBe(1);
  });
});

describe('keeping the log readable', () => {
  it('holds a journey’s lines and flushes them together', () => {
    const sink = buffered('Checkout');
    sink.log('✓ one');
    sink.log('✓ two');
    expect(sink.flush()).toBe('Checkout\n  ✓ one\n  ✓ two\n');
  });

  it('says nothing at all when there was nothing to say', () => {
    expect(buffered('Quiet').flush()).toBe('');
  });
});
