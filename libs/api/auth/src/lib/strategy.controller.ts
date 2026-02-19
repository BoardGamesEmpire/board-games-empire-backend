import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { StrategyService } from './strategy.service';

@ApiTags('strategies')
@Controller('strategies')
export class StrategyController {
  constructor(private strategyService: StrategyService) {}

  @Get()
  @AllowAnonymous()
  getStrategies() {
    return this.strategyService.getAvailableStrategies();
  }
}
