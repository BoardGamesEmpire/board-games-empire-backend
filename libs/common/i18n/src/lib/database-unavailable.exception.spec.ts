import { connectionTerminated, databaseUnreachable } from '@bge/database/testing';
import { t } from '@bge/i18n-core';
import {
  asDatabaseUnavailable,
  DATABASE_UNAVAILABLE,
  DatabaseUnavailableException,
} from './database-unavailable.exception';

describe('DatabaseUnavailableException (#1172)', () => {
  it('answers 503 DATABASE_UNAVAILABLE with the catalog copy and no other field', () => {
    const exception = new DatabaseUnavailableException(new Error('x'));

    expect(exception.getStatus()).toBe(503);
    expect(exception.getResponse()).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'DATABASE_UNAVAILABLE',
      message: t('errors.database.unavailable'),
    });
  });

  it('keeps the database error as its cause, for the logs', () => {
    const error = databaseUnreachable();

    expect(new DatabaseUnavailableException(error).cause).toBe(error);
  });

  it('names its code', () => {
    expect(DATABASE_UNAVAILABLE).toBe('DATABASE_UNAVAILABLE');
  });
});

describe('asDatabaseUnavailable (#1172)', () => {
  it.each([
    ['a Prisma outage', databaseUnreachable()],
    ["node-postgres's codeless one", connectionTerminated()],
  ])('turns %s into the exception, keeping it as the cause', (_, error) => {
    const outage = asDatabaseUnavailable(error);

    expect(outage).toBeInstanceOf(DatabaseUnavailableException);
    expect(outage?.cause).toBe(error);
  });

  it('leaves anything else alone', () => {
    expect(asDatabaseUnavailable(new TypeError('boom'))).toBeUndefined();
  });
});
