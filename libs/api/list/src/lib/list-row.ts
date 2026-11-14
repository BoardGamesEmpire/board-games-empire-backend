import type { Prisma } from '@bge/database';

/**
 * What a list row carries to the client: its own columns and how many entries
 * it holds, so a client can show a shelf of lists without fetching each one
 * (#1241). Each field is named, so no column ships by default (#460).
 */
export const LIST_SELECT = {
  id: true,
  userId: true,
  kind: true,
  name: true,
  description: true,
  reach: true,
  position: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { entries: true } },
} as const satisfies Prisma.ListSelect;

export type ListRow = Prisma.ListGetPayload<{ select: typeof LIST_SELECT }>;
