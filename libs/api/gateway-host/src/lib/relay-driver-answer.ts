import { RpcException } from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import { catchError, throwError } from 'rxjs';

/** gRPC's statuses for a failed call, CANCELLED (1) to UNAUTHENTICATED (16). */
const isGrpcErrorStatus = (code: unknown): code is number =>
  Number.isInteger(code) && Number(code) >= 1 && Number(code) <= 16;

/**
 * An error a driver raised with the gRPC status it stands for, such as
 * UNIMPLEMENTED. A DOMException carries a numeric code of its own, which
 * isn't a status: an aborted fetch's AbortError has 20 (#1082).
 */
const hasGrpcStatus = (err: unknown): err is Error & { code: number } =>
  // The cast only reads a property any Error may or may not carry, as unknown.
  err instanceof Error && !(err instanceof DOMException) && isGrpcErrorStatus((err as { code?: unknown }).code);

/**
 * The driver's answer, with an error that carries a gRPC status code sent
 * as that status. A driver can't depend on Nest, so it raises a plain
 * error with the code (`unsupportedOperation`), and this turns it into the
 * RpcException Nest's gRPC server reads the status from. Any other error
 * passes through as it is (#1082).
 *
 * Every controller that serves the gateway gRPC protocol from a driver
 * relays through it: a remote DataGateway's app, and the coordinator when
 * it answers for a plugin DataGateway (#1083).
 */
export function relayDriverAnswer<T>(answer: Observable<T>): Observable<T> {
  return answer.pipe(
    catchError((err: unknown) =>
      throwError(() => (hasGrpcStatus(err) ? new RpcException({ code: err.code, message: err.message }) : err)),
    ),
  );
}
