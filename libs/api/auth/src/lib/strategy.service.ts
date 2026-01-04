import { Injectable } from '@nestjs/common';

@Injectable()
export class StrategyService {
  getAvailableStrategies() {
    return ['emailAndPassword'];
  }
}
