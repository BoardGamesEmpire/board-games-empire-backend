import { Reach } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateGameDto, GAME_DESCRIPTION_MAX_LENGTH } from './create-game.dto';
import { UpdateGameDto } from './update-game.dto';

describe.each([
  ['CreateGameDto', CreateGameDto],
  ['UpdateGameDto', UpdateGameDto],
])('%s reach', (_name, Dto) => {
  // Mirrors the GLOBAL pipe (apps/api/src/main.ts), which refuses a property
  // the DTO does not declare rather than dropping it.
  const errorsFor = (plain: Record<string, unknown>) =>
    validate(plainToInstance(Dto, { title: 'Brass', ...plain }, { enableImplicitConversion: true }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it.each([Reach.Public, Reach.Private])('accepts %s', async (reach) => {
    await expect(errorsFor({ reach })).resolves.toHaveLength(0);
  });

  it.each([Reach.Friends, Reach.FriendsOfFriends])(
    'refuses %s — no read rule would honour it, so the game would be its creator’s alone',
    async (reach) => {
      const errors = await errorsFor({ reach });

      expect(errors.map((error) => error.property)).toEqual(['reach']);
    },
  );

  it('refuses Household, which is no longer a reach (#808)', async () => {
    const errors = await errorsFor({ reach: 'Household' });

    expect(errors.map((error) => error.property)).toEqual(['reach']);
  });

  it('accepts the field left out, which keeps the column default', async () => {
    await expect(errorsFor({})).resolves.toHaveLength(0);
  });

  it('refuses an explicit null rather than handing it to a non-nullable column', async () => {
    // `IsOptional` skips null as well as undefined, and `PartialType` adds it
    // to every field it copies, so null would reach Prisma and fail as a 500.
    const errors = await errorsFor({ reach: null });

    expect(errors.map((error) => error.property)).toEqual(['reach']);
  });

  it('refuses `visible`, the name the field used to be declared under (#491)', async () => {
    const errors = await errorsFor({ visible: Reach.Private });

    expect(errors.map((error) => error.property)).toEqual(['visible']);
  });

  it('refuses `visibility`, the name the field had before it was `reach` (#808)', async () => {
    const errors = await errorsFor({ visibility: Reach.Private });

    expect(errors.map((error) => error.property)).toEqual(['visibility']);
  });
});

describe.each([
  ['CreateGameDto', CreateGameDto],
  ['UpdateGameDto', UpdateGameDto],
])('%s description', (_name, Dto) => {
  const errorsFor = (description: string) => validate(plainToInstance(Dto, { title: 'Brass', description }));

  // The cap is the game service's, since only a new or changed description is held to it.
  it('accepts a description longer than the cap', async () => {
    await expect(errorsFor('a'.repeat(GAME_DESCRIPTION_MAX_LENGTH + 1))).resolves.toHaveLength(0);
  });
});
