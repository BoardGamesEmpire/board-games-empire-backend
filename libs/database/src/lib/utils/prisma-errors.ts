import { PrismaError } from '@status/codes';
import { Prisma } from '../client';

export function isPrismaUniqueConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === PrismaError.UniqueConstraintViolation;
}

export function isPrismaForeignKeyConstraintError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === PrismaError.ForeignKeyConstraintViolation;
}

export function isPrismaDependentRecordNotFoundError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === PrismaError.DependentRecordNotFound;
}

export function isPrismaRecordNotFoundError(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === PrismaError.RecordNotFound;
}
