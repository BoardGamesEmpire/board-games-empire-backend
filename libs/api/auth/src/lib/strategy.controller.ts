import { Controller, Get } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { StrategyService } from './strategy.service';

@Controller('strategies')
export class StrategyController {
  constructor(private strategyService: StrategyService) {}

  @Get()
  @AllowAnonymous()
  getStrategies() {
    return this.strategyService.getAvailableStrategies();
  }
}
