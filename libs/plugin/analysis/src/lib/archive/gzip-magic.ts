/** True when `head` starts with the two gzip magic bytes, `1f 8b`. */
export const isGzipMagic = (head: Uint8Array): boolean => head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
