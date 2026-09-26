import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListAuditLogsQueryDto } from './list-audit-logs.query.dto';

describe('ListAuditLogsQueryDto', () => {
  // Mirror the global ValidationPipe transform (query-string values arrive as
  // strings), matching the CappedPaginationQueryDto spec.
  const toDto = (plain: Record<string, unknown>): ListAuditLogsQueryDto =>
    plainToInstance(ListAuditLogsQueryDto, plain, { enableImplicitConversion: true });

  const errorsFor = async (property: string, plain: Record<string, unknown>) =>
    (await validate(toDto(plain))).filter((e) => e.property === property);

  // Regression for the forensic-integrity bug: the service gates each filter on
  // truthiness, so an empty-string param drops the clause and widens the result
  // set. These must fail validation (400) rather than reach the service as ''.
  const STRING_FILTERS = ['subject', 'subjectId', 'actorUserId', 'event', 'correlationId'] as const;

  describe.each(STRING_FILTERS)('%s filter', (field) => {
    it('rejects an empty string (would otherwise silently drop the filter)', async () => {
      const errors = await errorsFor(field, { [field]: '' });
      expect(errors).toHaveLength(1);
      expect(errors[0].constraints).toHaveProperty('isNotEmpty');
    });

    it('accepts a non-empty value', async () => {
      expect(await errorsFor(field, { [field]: 'value' })).toHaveLength(0);
    });

    it('leaves the filter optional — absent is valid', async () => {
      expect(await errorsFor(field, {})).toHaveLength(0);
    });
  });

  // Each failure must name a validation catalog key, so the edge can render it
  // in the request locale. Without implicit conversion, so a number
  // stays a number and trips @IsString.
  describe('failure messages', () => {
    const keysFor = async (plain: Record<string, unknown>) =>
      validationCatalogKeys(await validate(plainToInstance(ListAuditLogsQueryDto, plain)));

    it('names a catalog key for every type and enum failure', async () => {
      const keys = await keysFor({
        ...Object.fromEntries(STRING_FILTERS.map((field) => [field, 42])),
        actorKind: 'robot',
        action: 'upsert',
        source: 'fax',
        occurredFrom: 'not-a-date',
        occurredTo: 'not-a-date',
      });

      expect(keys).toEqual({
        ...Object.fromEntries(STRING_FILTERS.map((field) => [`${field}.isString`, 'validation.isString'])),
        'actorKind.isIn': 'validation.isIn',
        'action.isIn': 'validation.isIn',
        'source.isIn': 'validation.isIn',
        'occurredFrom.isDate': 'validation.isDate',
        'occurredTo.isDate': 'validation.isDate',
      });
    });

    it('names a catalog key for every empty filter', async () => {
      const keys = await keysFor(Object.fromEntries(STRING_FILTERS.map((field) => [field, ''])));

      expect(keys).toEqual(
        Object.fromEntries(STRING_FILTERS.map((field) => [`${field}.isNotEmpty`, 'validation.isNotEmpty'])),
      );
    });
  });
});
