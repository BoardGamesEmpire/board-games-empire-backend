import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AbilityService } from '../ability.service';

/**
 * Resolves the current actor's abilities and primes them into CLS, before
 * guards run. Implemented as middleware (not an interceptor) so it executes
 * BEFORE `PoliciesGuard`, and applied AFTER `HttpActorMiddleware` (which
 * populates the actor this reads) within an open CLS scope.
 *
 * All priming logic lives in `AbilityService.primeCurrentActor()`; this is just
 * the HTTP seam that invokes it. The same call is made by the BullMQ worker host
 * (`AbilityAwareWorkerHost`) and, in future, the WS/gRPC populators.
 */
@Injectable()
export class AbilityContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AbilityContextMiddleware.name);

  constructor(private readonly abilityService: AbilityService) {}

  async use(_req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      await this.abilityService.primeCurrentActor();
      next();
    } catch (error) {
      this.logger.error('Error in AbilityContextMiddleware', error instanceof Error ? error.stack : String(error));
      // Forward to the Nest/Express error pipeline rather than throwing
      // synchronously from async middleware.
      next(error);
    }
  }
}
