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
});
