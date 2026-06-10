import type { Actor } from '@bge/actor-context';

/**
 * Span-safe snapshot of the current audit context, returned by an
 * {@link ActorContextProvider}. Fields are independently optional so the
 * provider can omit values that aren't present (e.g. household scope is
 * only set inside household-scoped operations).
 *
 * The shape deliberately includes the full `Actor` union so the
 * {@link ActorSpanProcessor} can branch on `kind` to emit the right
 * subset of attributes. The processor is responsible for the PII filter;
 * the provider is responsible for sourcing.
 */
export interface ActorSpanContext {
  actor?: Actor;
  correlationId?: string;
  householdId?: string;
}

/**
 * Callback invoked on every span start to pull the current audit context.
 * Decouples `@bge/otel` from the CLS internals of `@bge/actor-context`:
 * the host application closes over `ClsServiceManager.getClsService()`
 * (or a stub in tests) and returns whatever it finds, returning `{}` when
 * no context is active.
 *
 * Must not throw — the processor will catch any thrown error and skip
 * annotation rather than disrupt tracing, but a clean return is faster.
 *
 * Pre-bootstrap call sites (before NestFactory.create) will always see
 * `{}` because no CLS has been entered yet. That's expected; bootstrap
 * spans simply carry no actor metadata.
 */
export type ActorContextProvider = () => ActorSpanContext;

/**
 * No-op provider used pre-bootstrap and in tests that don't care about
 * span annotation. Always returns an empty snapshot.
 */
export const noopActorContextProvider: ActorContextProvider = () => ({});
