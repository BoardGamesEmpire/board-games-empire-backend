import { i18nValidationMessage } from '@bge/i18n';
import { TransformBoolean } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UninstallPluginDto {
  @ApiPropertyOptional({
    description:
      'Also delete retained household/user configuration rows. Defaults to false — the tombstone exists to preserve them for a reinstall.',
    default: false,
  })
  // The global pipe's implicit conversion coerces with `Boolean(value)`, so a
  // form-encoded `purgeData=false` (the app parses urlencoded bodies) would
  // arrive as TRUE and delete the config rows the caller just opted out of
  // deleting. `@TransformBoolean` reads the raw value instead.
  @TransformBoolean()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  purgeData?: boolean;
}
