import { randomOffsets, sampleByOffsets, sampleWithoutReplacement } from './random-sample';

describe('sampleWithoutReplacement', () => {
  it('never returns more than it was given', () => {
    expect(sampleWithoutReplacement(['a', 'b'], 5).sort()).toEqual(['a', 'b']);
  });

  it('leaves its input untouched', () => {
    const items = ['a', 'b', 'c', 'd'];

    sampleWithoutReplacement(items, 2);

    expect(items).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('randomOffsets', () => {
  it.each([
    [0, 10],
    [3, 10],
    [10, 3],
    [50, 50],
  ])('returns min(size, count) distinct offsets inside a set of %i, for a sample of %i', (count, size) => {
    const offsets = randomOffsets(count, size);

    expect(offsets).toHaveLength(Math.min(size, count));
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(offsets.every((offset) => Number.isInteger(offset) && offset >= 0 && offset < count)).toBe(true);
  });

  it('returns every offset once when the set is no larger than the sample', () => {
    expect(randomOffsets(4, 10)).toEqual([0, 1, 2, 3]);
  });

  // #960: a uniform sample. 2000 draws of 2 from 5 expect each offset 800
  // times, with a standard deviation near 22, so the bounds are far outside
  // chance and well inside what a biased pick would miss.
  it('draws each offset about equally often', () => {
    const hits = [0, 0, 0, 0, 0];

    for (let run = 0; run < 2000; run++) {
      for (const offset of randomOffsets(5, 2)) {
        hits[offset]++;
      }
    }

    for (const count of hits) {
      expect(count).toBeGreaterThan(600);
      expect(count).toBeLessThan(1000);
    }
  });

  // The sample walks the offsets in this order, one read starting where the
  // last one stopped.
  it('returns the offsets in ascending order', () => {
    for (let run = 0; run < 50; run++) {
      const offsets = randomOffsets(100, 10);

      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    }
  });
});

describe('sampleByOffsets', () => {
  const rowsOf = (count: number) => Array.from({ length: count }, (_, index) => `row-${index}`);

  // Reads the way a cursor read does: `skip` rows past `after`, or `skip`
  // rows in without one, recording each offset it lands on.
  const readerOver = (rows: string[]) => {
    const landed: number[] = [];
    const readAt = jest.fn(async (skip: number, after: string | undefined) => {
      const at = (after === undefined ? 0 : rows.indexOf(after)) + skip;

      landed.push(at);

      return rows[at] ?? null;
    });

    return { readAt, landed };
  };

  it('reads once per offset, one read at a time, and returns what the reads found', async () => {
    let inFlight = 0;
    const { readAt, landed } = readerOver(rowsOf(10));
    const reader = async (skip: number, after: string | undefined) => {
      expect(++inFlight).toBe(1);
      await Promise.resolve();
      inFlight--;

      return readAt(skip, after);
    };

    const rows = await sampleByOffsets(10, 3, reader);

    expect(readAt).toHaveBeenCalledTimes(3);
    expect([...rows].sort()).toEqual(landed.map((at) => `row-${at}`).sort());
  });

  // #960, #961: a read at offset k walks k rows. Starting each read from the
  // row the last one found keeps the whole sample to one walk of the set.
  it('walks the offsets in ascending order, each read starting from the last row found', async () => {
    const { readAt, landed } = readerOver(rowsOf(1000));

    await sampleByOffsets(1000, 50, readAt);

    expect(new Set(landed).size).toBe(50);
    expect(landed).toEqual([...landed].sort((a, b) => a - b));
    expect(readAt.mock.calls[0][1]).toBeUndefined();
    for (const [index, [skip, after]] of readAt.mock.calls.slice(1).entries()) {
      expect(after).toBe(`row-${landed[index]}`);
      expect(skip).toBe(landed[index + 1] - landed[index]);
    }

    const walked = readAt.mock.calls.reduce((sum, [skip]) => sum + skip, 0);
    expect(walked).toBeLessThan(1000);
  });

  // The walk finds the rows in set order. The sample must not show them that
  // way every time.
  it('returns the rows in random order', async () => {
    const orders = new Set<string>();

    for (let run = 0; run < 200; run++) {
      orders.add((await sampleByOffsets(3, 3, readerOver(rowsOf(3)).readAt)).join());
    }

    expect(orders.size).toBeGreaterThan(1);
  });

  it('reads nothing for an empty set', async () => {
    const readAt = jest.fn();

    expect(await sampleByOffsets(0, 10, readAt)).toEqual([]);
    expect(readAt).not.toHaveBeenCalled();
  });

  // A row deleted between the count and the walk leaves the later offsets past
  // the end of the set. The sample comes back short rather than with a hole.
  it('stops at a read that found nothing rather than returning a hole', async () => {
    const readAt = jest.fn(async (skip: number) => (skip === 0 ? 'row' : null));

    expect(await sampleByOffsets(3, 3, readAt)).toEqual(['row']);
    expect(readAt).toHaveBeenCalledTimes(2);
  });
});
