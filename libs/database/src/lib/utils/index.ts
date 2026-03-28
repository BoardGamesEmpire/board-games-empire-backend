import { PrismaError } from '@status/codes';
import { Prisma } from '../client';

export function isPrismaUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === PrismaError.UniqueConstraintViolation;
}
