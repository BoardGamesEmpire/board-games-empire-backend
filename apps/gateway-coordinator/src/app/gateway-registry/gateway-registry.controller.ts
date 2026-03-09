import { Controller } from '@nestjs/common';
import { GatewayRegistryService } from './gateway-registry.service';

@Controller()
export class GatewayRegistryController {
  constructor(private readonly gatewayRegistryService: GatewayRegistryService) {}
}
