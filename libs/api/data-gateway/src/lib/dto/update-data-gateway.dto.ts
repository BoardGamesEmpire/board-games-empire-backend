import { DataGatewayCapability } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsString, ValidateIf } from 'class-validator';
import { CreateDataGatewayDto } from './create-data-gateway.dto';

/**
 * The DTO lets null through to the nullable fields, which it clears, and to
 * the connection fields. The service, which knows the row's kind, refuses any
 * connection field on a plugin DataGateway's row, and null for a remote
 * DataGateway's address, port or authentication type (#1083).
 *
 * `name` and `enabled` are redeclared rather than inherited: `PartialType`
 * adds `IsOptional` to every field it copies, which skips `null` as well as a
 * missing key, so `null` reached their non-nullable columns as a 500 (#1275).
 */
export class UpdateDataGatewayDto extends PartialType(OmitType(CreateDataGatewayDto, ['name', 'enabled'] as const)) {
  @ApiPropertyOptional({ description: 'Unique name of the DataGateway' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name?: string;

  @Type(() => Boolean)
  @ApiPropertyOptional({ description: 'Indicates whether the DataGateway is enabled' })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  enabled?: boolean;

  @ApiPropertyOptional({
    enum: DataGatewayCapability,
    enumName: 'DataGatewayCapability',
    isArray: true,
    description:
      "The capabilities to switch off, as the whole list: `[]` switches every one back on. The server doesn't " +
      'route a switched-off capability, and no interview changes the list. It may name a capability the ' +
      "DataGateway doesn't declare yet, which stays off if it's declared later (#715). A list switched back on " +
      'is loaded again straight away (#718).',
  })
  // Not IsOptional, which lets null through to a list column the database
  // won't set to null: send [] to switch every capability back on.
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsIn(Object.values(DataGatewayCapability), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  disabledCapabilities?: DataGatewayCapability[];
}
