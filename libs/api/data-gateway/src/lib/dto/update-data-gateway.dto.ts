import { DataGatewayCapability } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsArray, IsIn, ValidateIf } from 'class-validator';
import { CreateDataGatewayDto } from './create-data-gateway.dto';

export class UpdateDataGatewayDto extends PartialType(CreateDataGatewayDto) {
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
