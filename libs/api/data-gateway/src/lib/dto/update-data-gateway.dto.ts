import { PartialType } from '@nestjs/swagger';
import { CreateDataGatewayDto } from './create-data-gateway.dto';

export class UpdateDataGatewayDto extends PartialType(CreateDataGatewayDto) {}
