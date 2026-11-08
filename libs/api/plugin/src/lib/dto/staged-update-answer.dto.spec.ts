import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApprovePluginUpdateDto } from './approve-plugin-update.dto';
import { RejectPluginUpdateDto } from './reject-plugin-update.dto';
import { StagedUpdateAnswerDto } from './staged-update-answer.dto';

// Approve and reject answer the same staged update, so one declaration of
// `stagingId` serves both and one spec holds them to it (#1118).
describe.each([
  ['ApprovePluginUpdateDto', ApprovePluginUpdateDto],
  ['RejectPluginUpdateDto', RejectPluginUpdateDto],
])('%s as a staged-update answer', (_name, Answer) => {
  // Mirrors the global pipe (apps/api/src/main.ts), which converts implicitly.
  const errorsFor = (plain: Record<string, unknown>) =>
    validate(plainToInstance(Answer, plain, { enableImplicitConversion: true }));

  const invalidProperties = async (plain: Record<string, unknown>): Promise<string[]> =>
    (await errorsFor(plain)).map((error) => error.property);

  it('extends the shared staged-update answer (#1118)', () => {
    expect(Object.getPrototypeOf(Answer)).toBe(StagedUpdateAnswerDto);
  });

  it('requires the staging id the staged-update read reported (#357)', async () => {
    await expect(invalidProperties({})).resolves.toEqual(['stagingId']);
  });

  it('refuses an empty staging id (#357)', async () => {
    await expect(invalidProperties({ stagingId: '' })).resolves.toEqual(['stagingId']);
  });

  it('refuses a staging id that is not a string under the isString constraint alone, for both answers (#1118)', async () => {
    // The global pipe's implicit conversion would turn this into a string, so validate it unconverted.
    const [error] = await validate(plainToInstance(Answer, { stagingId: { nested: true } }));

    expect(error.property).toBe('stagingId');
    expect(Object.keys(error.constraints ?? {}).sort()).toEqual(['isString']);
  });

  it('names the same constraints for a missing staging id (#1118)', async () => {
    const [error] = await errorsFor({});

    expect(Object.keys(error.constraints ?? {}).sort()).toEqual(['isNotEmpty', 'isString']);
  });

  it('accepts a staging id (#357)', async () => {
    await expect(invalidProperties({ stagingId: 'staging-a' })).resolves.toEqual([]);
  });
});
