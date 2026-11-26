import { InviteStatus, InviteType } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListReceivedInvitesQueryDto } from './list-received-invites-query.dto';
import { ListSentInvitesQueryDto } from './list-sent-invites-query.dto';

type PlainQuery = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(
  dto: typeof ListReceivedInvitesQueryDto | typeof ListSentInvitesQueryDto,
  query: PlainQuery,
): Promise<string[]> {
  const instance = plainToInstance(dto, query, { enableImplicitConversion: true });
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe.each([
  ['ListReceivedInvitesQueryDto', ListReceivedInvitesQueryDto],
  ['ListSentInvitesQueryDto', ListSentInvitesQueryDto],
])('%s type filter (#742)', (_name, dto) => {
  it('accepts no filter', async () => {
    await expect(propertiesWithErrors(dto, {})).resolves.toEqual([]);
  });

  it.each([InviteType.Household, InviteType.Event])('accepts ?type=%s', async (type) => {
    await expect(propertiesWithErrors(dto, { type })).resolves.toEqual([]);
  });

  // No party route serves these kinds, so filtering to one is a mistake, not an empty page.
  it.each([InviteType.System, InviteType.Campaign, 'household', ''])('refuses ?type=%p', async (type) => {
    await expect(propertiesWithErrors(dto, { type })).resolves.toEqual(['type']);
  });
});

describe('ListSentInvitesQueryDto status filter (#751)', () => {
  it('takes a status beside the type', async () => {
    await expect(
      propertiesWithErrors(ListSentInvitesQueryDto, { status: InviteStatus.Expired, type: InviteType.Household }),
    ).resolves.toEqual([]);
  });

  it('refuses an unknown status', async () => {
    await expect(propertiesWithErrors(ListSentInvitesQueryDto, { status: 'Lapsed' })).resolves.toEqual(['status']);
  });
});
