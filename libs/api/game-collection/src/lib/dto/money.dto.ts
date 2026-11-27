import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';

/** The largest price a column of 32-bit integers holds, in minor units (#1231). */
export const MAX_MONEY_AMOUNT = 2147483647;

/**
 * A price on the wire: whole minor units and an ISO 4217 code. The code's
 * membership of the ISO list is checked in the service, where a refusal can
 * carry its own error code; the pattern here only keeps the shape (#1231).
 */
export class MoneyDto {
  @ApiProperty({
    description: 'The price in minor units of the currency: 1250 is 12.50 in a currency with two decimals.',
    minimum: 0,
    maximum: MAX_MONEY_AMOUNT,
    example: 1250,
  })
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  @Max(MAX_MONEY_AMOUNT, { message: i18nValidationMessage('validation.max') })
  amount!: number;

  @ApiProperty({
    description: 'ISO 4217 currency code, three uppercase letters.',
    example: 'EUR',
    pattern: '^[A-Z]{3}$',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Matches(/^[A-Z]{3}$/, { message: i18nValidationMessage('validation.isCurrencyCode') })
  currency!: string;
}
