import { RiskLevel } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsString,
  NotContains,
  ValidateBy,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';

/**
 * The value as the request sent it, not as the global pipe's implicit
 * conversion left it: that makes a number '5' and an object '[object Object]'
 * for a string property, the string 'false' `true` for a boolean one, and
 * copies an object key by key. Left as sent, a value of the wrong kind fails
 * its validator, and a condition reaches the check exactly as written.
 */
const asSent = ({ obj, key }: { obj: Record<string, unknown>; key: string }): unknown => obj[key];

const NUL = '\u0000';

/** Whether a JSON value holds a NUL character in any string or key, at any depth. */
function holdsNul(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(NUL);
  }

  if (Array.isArray(value)) {
    return value.some(holdsNul);
  }

  return (
    value !== null &&
    typeof value === 'object' &&
    Object.entries(value).some(([key, nested]) => key.includes(NUL) || holdsNul(nested))
  );
}

/**
 * Refuses a NUL character anywhere in a JSON value. Postgres cannot store one
 * in `jsonb`, so the write would fail with a bare 500 (#772). The probe catches
 * most, but not on every path a condition reaches the write by.
 */
function NoNulAnywhere(options: ValidationOptions): PropertyDecorator {
  return ValidateBy({ name: 'noNullCharacter', validator: { validate: (value) => !holdsNul(value) } }, options);
}

/**
 * The Owner's edit to one permission (#772). A property the body omits is left
 * as it is, and an edit marks the permission as the Owner's, so the next start
 * keeps it.
 *
 * Only these can change. Changing a permission's action or resource type would
 * make its slug name something else, nothing enforces its fields yet (#589),
 * and every role rule is a grant, never a denial. The global pipe refuses any
 * other key with 400.
 *
 * Each property validates under `@ValidateIf(value !== undefined)` rather than
 * `@IsOptional`, which would let `null` through unvalidated. `reason` is the
 * one property where `null` means something: no reason.
 */
export class UpdatePermissionDto {
  @ApiPropertyOptional({
    description:
      'The condition that limits which records the permission reaches: a Prisma `where` clause for its resource ' +
      'type, with placeholders such as `{{ user.id }}` in its values. An empty object is no condition, so the ' +
      'permission reaches every record of its resource type. `null` is refused: send `{}` for no condition.',
    type: 'object',
    additionalProperties: true,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject({ message: i18nValidationMessage('validation.isObject') })
  @NoNulAnywhere({ message: i18nValidationMessage('validation.noNullCharacter') })
  @Transform(asSent)
  conditions?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Why the permission exists, in a sentence. Null clears it.',
    type: String,
    nullable: true,
  })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  @Transform(asSent)
  reason?: string | null;

  @ApiPropertyOptional({
    description:
      'How dangerous the permission is to hand over. A plugin consent decision made at a lower level stops ' +
      'conferring the permission until it is given again.',
    enum: RiskLevel,
    enumName: 'RiskLevel',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(RiskLevel, { message: i18nValidationMessage('validation.isEnum') })
  riskLevel?: RiskLevel;

  @ApiPropertyOptional({
    description:
      'True retires the permission: it is kept, and confers nothing through any role, key or plugin that holds ' +
      'it. False revives a retired permission, which must then pass the same checks as any edit.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @Transform(asSent)
  retired?: boolean;
}
