import type { EventSource } from '@bge/actor-context';
import { AuditContextInternalService } from '@bge/actor-context/internal';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { NextParameters, RunConditionParameters } from 'surrogate';
import { NextPre, SurrogateDelegate } from 'surrogate';

type Intercept = Parameters<ActorInterceptor['intercept']>;

@SurrogateDelegate()
export abstract class ActorInterceptor implements NestInterceptor {
  protected logger = new Logger(this.constructor.name);

  protected readonly auditSource?: EventSource;
  protected abstract readonly executionContextType: string;

  constructor(protected readonly auditContext: AuditContextInternalService) {}

  abstract intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown>;

  get source(): EventSource {
    return (this.auditSource || this.executionContextType) as EventSource;
  }

  @NextPre({
    action: 'intercept',
    options: {
      runConditions(this: ActorInterceptor, provider: RunConditionParameters<ActorInterceptor, Intercept>): boolean {
        const [executionContext] = provider.originalArgs;
        return executionContext.getType() !== this.executionContextType;
      },
    },
  })
  protected bailOnWrongContext(params: NextParameters<ActorInterceptor, Intercept>) {
    const [, next] = params.originalArgs;
    this.logger.debug(
      `Execution context type mismatch; skipping actor population. ` +
        `Expected '${this.executionContextType}', got '${params.originalArgs[0].getType()}'`,
    );
    return params.next.bail({
      bailWith: next.handle(),
    });
  }
}
