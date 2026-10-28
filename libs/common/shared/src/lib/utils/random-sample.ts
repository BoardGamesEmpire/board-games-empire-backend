/**
 * Up to `size` distinct items, uniformly at random: a partial Fisher-Yates
 * over a copy, so the input is untouched and each item is equally likely.
 */
export function sampleWithoutReplacement<T>(items: readonly T[], size: number): T[] {
  const pool = [...items];
  const count = Math.min(size, pool.length);

  for (let index = 0; index < count; index++) {
    const pick = index + Math.floor(Math.random() * (pool.length - index));
    [pool[index], pool[pick]] = [pool[pick], pool[index]];
  }

  return pool.slice(0, count);
}

/**
 * `min(size, count)` distinct offsets into a set of `count` rows, every subset
 * equally likely, in ascending order.
 *
 * Floyd's algorithm picks the subset without materialising the set: the set
 * may be the whole game catalog, so the work and memory stay proportional to
 * the sample, not the set (#961).
 */
export function randomOffsets(count: number, size: number): number[] {
  const wanted = Math.min(size, count);
  const picked = new Set<number>();

  for (let upper = count - wanted; upper < count; upper++) {
    const pick = Math.floor(Math.random() * (upper + 1));
    picked.add(picked.has(pick) ? upper : pick);
  }

  return [...picked].sort((a, b) => a - b);
}

/**
 * A uniform sample of a counted set, in random order (#960, #961). `readAt`
 * reads the row `skip` rows past `after`, or `skip` rows in when there is no
 * `after`, in a fixed order over the same set that was counted.
 *
 * The offsets are walked in ascending order, each read starting from the row
 * the last one found. A read at offset k walks k rows, so reading each offset
 * from the start would walk the set about `size / 2` times over; this way the
 * reads together walk it at most once. The rows come back in that order, so a
 * shuffle follows.
 *
 * `null` means nothing is there any more, and every later offset lies past it
 * too, so the sample comes back short rather than with a hole.
 *
 * The reads run one at a time: each starts from the row the one before found.
 */
export async function sampleByOffsets<T>(
  count: number,
  size: number,
  readAt: (skip: number, after: T | undefined) => Promise<T | null>,
): Promise<T[]> {
  const rows: T[] = [];
  let reached = 0;

  for (const offset of randomOffsets(count, size)) {
    const row = await readAt(offset - reached, rows.at(-1));

    if (row === null) {
      break;
    }

    rows.push(row);
    reached = offset;
  }

  return sampleWithoutReplacement(rows, rows.length);
}
