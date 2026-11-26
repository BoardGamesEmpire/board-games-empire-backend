import { currencyUnknown } from '../game-collection.errors';

/**
 * A price: whole minor units of a currency, so 12.50 euro is `1250` `EUR`.
 * Whole numbers keep a price exact, where a fraction would drift (#1231).
 */
export interface Money {
  amount: number;
  currency: string;
}

const KNOWN_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

/** Refuses a code the runtime's ISO 4217 list lacks; it lists uppercase codes only (#1231). */
export function assertKnownCurrency(code: string): void {
  if (!KNOWN_CURRENCIES.has(code)) {
    throw currencyUnknown(code);
  }
}

/** Pairs the two stored columns; a price with either one missing is unknown (#1231). */
export function moneyFromColumns(amount: number | null, currency: string | null): Money | null {
  if (amount === null || currency === null) {
    return null;
  }

  return { amount, currency };
}
