import type { AuditContextService } from '@bge/actor-context';
import type { ArgumentMetadata } from '@nestjs/common';
import type { I18nValidationPipeOptions } from 'nestjs-i18n';
import { I18nValidationPipe } from 'nestjs-i18n';

/**
 * The api's global validation, which checks a route's parameters only.
 *
 * Nest runs global pipes on a gateway's message parameters too, and hands a
 * frame's payload to them as `body`, the same as a request's. The frame's own
 * CLS scope is what tells them apart: `WsActorScope` opens it with source
 * `ws`. A gateway validates its frames with the pipes on its handlers, so a
 * frame passes through here unchanged (#180).
 *
 * A pipe is not handed the execution context, so the scope is the only sign of
 * a frame it has. `AuthenticatedGateway` runs every frame in one
 * (`WsFrameScope`), and its `WsFrameScopeGuard` refuses a frame outside one
 * before any pipe runs. A gateway that does not extend it must open the scope
 * itself, or this pipe validates its frames as HTTP bodies. The pipe validates
 * whatever is not a frame's, an unscoped request included, so a missing scope
 * costs a gateway strictness, never an HTTP route its validation.
 */
export class RouteValidationPipe extends I18nValidationPipe {
  constructor(
    private readonly auditContext: AuditContextService,
    options?: I18nValidationPipeOptions,
  ) {
    super(options);
  }

  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    if (this.auditContext.getSource() === 'ws') {
      return value;
    }

    return super.transform(value, metadata);
  }
}
