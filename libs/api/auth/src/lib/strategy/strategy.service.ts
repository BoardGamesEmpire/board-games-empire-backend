import { Injectable } from '@nestjs/common';

@Injectable()
export class StrategyService {
  getAvailableStrategies() {
    // TODO: evaluate available strategies based on configuration, environment variables, etc.
    return ['emailAndPassword'];
  }
}
