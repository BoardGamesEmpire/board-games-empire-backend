import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The longest DataGateway id, external ID or game id the route accepts
 * (#1067). Each DataGateway checks its own external IDs' format, so this only
 * bounds what reaches the coordinator, whose expansions cache each one keys.
 */
export const EXPANSIONS_ID_MAX_LENGTH = 128;

/**
 * The longest locale the route accepts (#1067): 35 characters, the length
 * RFC 5646 (section 4.4.1) asks every language tag reader to support. The
 * locale keys the coordinator's expansions cache too.
 */
export const EXPANSIONS_LOCALE_MAX_LENGTH = 35;

/**
 * `GET /games/search/expansions` (#1067).
 *
 * The base game is named one of two ways: `gatewayId` and `externalId`
 * together, or `gameId` alone. That rule spans fields, so the service enforces
 * it rather than a decorator, as `CreateGameShareDto`'s recipient does.
 */
export class ExpansionsQueryDto {
  @ApiPropertyOptional({
    description:
      'The DataGateway to ask, as a game search result names it. Give this with `externalId`, or give `gameId`.',
    maxLength: EXPANSIONS_ID_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(EXPANSIONS_ID_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  gatewayId?: string;

  @ApiPropertyOptional({
    description: "The base game's external ID at that DataGateway, as a game search result gives it.",
    maxLength: EXPANSIONS_ID_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(EXPANSIONS_ID_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  externalId?: string;

  @ApiPropertyOptional({
    description:
      "The base game's ID on this server. Each of its DataGateway links is asked. Give this, or `gatewayId` and `externalId`.",
    maxLength: EXPANSIONS_ID_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(EXPANSIONS_ID_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  gameId?: string;

  @ApiPropertyOptional({
    description: 'The locale to ask the DataGateways in, as a hint (e.g. "en", "de")',
    maxLength: EXPANSIONS_LOCALE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(EXPANSIONS_LOCALE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  locale?: string;
}
