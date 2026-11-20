import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsInt, Min, ValidateIf } from 'class-validator';
import { CreateEventOccurrenceDto } from './create-event-occurrence.dto';

/**
 * A patch to a date. Each field is optional, so a patch names only what it
 * changes, and `null` clears a nullable one.
 *
 * `sortOrder` is redeclared rather than inherited: `PartialType` adds
 * `IsOptional` to every field it copies, which skips `null` as well as a
 * missing key, so `null` reached the non-nullable column as a 500 (#1275).
 */
export class UpdateEventOccurrenceDto extends PartialType(OmitType(CreateEventOccurrenceDto, ['sortOrder'] as const)) {
  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  sortOrder?: number;
}
