import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MoneyDto } from './money.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function validated(payload: Record<string, unknown>) {
  const dto = plainToInstance(MoneyDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, properties: errors.map((error) => error.property) };
}

describe('MoneyDto (#1231)', () => {
  it('accepts an integer amount of minor units with a currency', async () => {
    await expect(validated({ amount: 1250, currency: 'EUR' })).resolves.toMatchObject({ properties: [] });
  });

  it('reads a numeric string as its number, as the global pipe does', async () => {
    const { dto, properties } = await validated({ amount: '12', currency: 'EUR' });

    expect(properties).toEqual([]);
    expect(dto.amount).toBe(12);
  });

  it.each([0, 2147483647])('accepts the amount %d at either end of the range', async (amount) => {
    await expect(validated({ amount, currency: 'EUR' })).resolves.toMatchObject({ properties: [] });
  });

  it.each([-1, 2147483648, 1.5])('refuses the amount %d', async (amount) => {
    await expect(validated({ amount, currency: 'EUR' })).resolves.toMatchObject({ properties: ['amount'] });
  });

  it('refuses a missing amount', async () => {
    await expect(validated({ currency: 'EUR' })).resolves.toMatchObject({ properties: ['amount'] });
  });

  it.each(['eur', 'EU', 'EURO', '', 'E1R'])('refuses the currency %j', async (currency) => {
    await expect(validated({ amount: 1, currency })).resolves.toMatchObject({ properties: ['currency'] });
  });

  // Implicit conversion turns an object into '[object Object]' before any
  // validator runs, so the pattern is what refuses it.
  it('refuses an object as the currency', async () => {
    await expect(validated({ amount: 1, currency: {} })).resolves.toMatchObject({ properties: ['currency'] });
  });

  it('refuses a field it does not name', async () => {
    await expect(validated({ amount: 1, currency: 'EUR', extra: true })).resolves.toMatchObject({
      properties: ['extra'],
    });
  });
});
