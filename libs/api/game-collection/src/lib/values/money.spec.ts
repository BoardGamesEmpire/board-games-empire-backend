import { assertKnownCurrency, moneyFromColumns } from './money';

/** The refusal `fn` throws, so a spec can match its status and code. */
function refusal(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }

  return undefined;
}

describe('assertKnownCurrency (#1231)', () => {
  it.each(['EUR', 'JPY', 'USD'])('accepts %s', (code) => {
    expect(() => assertKnownCurrency(code)).not.toThrow();
  });

  it('refuses an unknown code with COLLECTION_CURRENCY_UNKNOWN', () => {
    expect(refusal(() => assertKnownCurrency('XXY'))).toMatchObject({
      status: 400,
      code: 'COLLECTION_CURRENCY_UNKNOWN',
    });
  });

  it('refuses a lowercase code, which is not ISO 4217 spelling', () => {
    expect(refusal(() => assertKnownCurrency('eur'))).toMatchObject({ code: 'COLLECTION_CURRENCY_UNKNOWN' });
  });
});

describe('moneyFromColumns (#1231)', () => {
  it('is null when the price is unknown', () => {
    expect(moneyFromColumns(null, null)).toBeNull();
  });

  it('pairs the minor-unit amount with its currency', () => {
    expect(moneyFromColumns(1250, 'EUR')).toEqual({ amount: 1250, currency: 'EUR' });
  });

  it('keeps a free copy: an amount of zero is a price', () => {
    expect(moneyFromColumns(0, 'EUR')).toEqual({ amount: 0, currency: 'EUR' });
  });
});
