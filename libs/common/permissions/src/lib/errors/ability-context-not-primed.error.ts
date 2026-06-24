import { InternalServerErrorException } from '@nestjs/common';

/**
 * Raised when the current abilities are requested but nothing was primed into
 * CLS — i.e. `AbilityContextMiddleware` did not run for this context. A
 * programmer error / misconfiguration (500), explicitly NOT an authorization
 * failure (`ForbiddenException`/403). Subclasses `InternalServerErrorException`
 * so it integrates with Nest's exception layer while staying greppable and
 * filter-matchable.
 */
export class AbilityContextNotPrimedError extends InternalServerErrorException {
  constructor() {
    super(
      'No abilities are present in the current context. Either no actor was ' +
        'resolved for this request, or AbilityContextMiddleware did not run. ' +
        'For explicit-actor scenarios (tests, listeners, replay) use ' +
        'resolveAbilitiesForActor(actor).',
    );
  }
}
