import { Visibility } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGameDto } from './create-game.dto';
import { UpdateGameDto } from './update-game.dto';

describe.each([
  ['CreateGameDto', CreateGameDto],
  ['UpdateGameDto', UpdateGameDto],
])('%s visibility', (_name, Dto) => {
  // Mirrors the GLOBAL pipe (apps/api/src/main.ts), which refuses a property
  // the DTO does not declare rather than dropping it.
  const errorsFor = (plain: Record<string, unknown>) =>
    validate(plainToInstance(Dto, { title: 'Brass', ...plain }, { enableImplicitConversion: true }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it.each([Visibility.Public, Visibility.Private])('accepts %s', async (visibility) => {
    await expect(errorsFor({ visibility })).resolves.toHaveLength(0);
  });

  it.each([Visibility.Household, Visibility.Friends, Visibility.FriendsOfFriends])(
    'refuses %s — no read rule would honour it, so the game would be its creator’s alone',
    async (visibility) => {
      const errors = await errorsFor({ visibility });

      expect(errors.map((error) => error.property)).toEqual(['visibility']);
    },
  );

  it('accepts the field left out, which keeps the column default', async () => {
    await expect(errorsFor({})).resolves.toHaveLength(0);
  });

  it('refuses an explicit null rather than handing it to a non-nullable column', async () => {
    // `IsOptional` skips null as well as undefined, and `PartialType` adds it
    // to every field it copies, so null would reach Prisma and fail as a 500.
    const errors = await errorsFor({ visibility: null });

    expect(errors.map((error) => error.property)).toEqual(['visibility']);
  });

  it('refuses `visible`, the name the field used to be declared under (#491)', async () => {
    const errors = await errorsFor({ visible: Visibility.Private });

    expect(errors.map((error) => error.property)).toEqual(['visible']);
  });
});
