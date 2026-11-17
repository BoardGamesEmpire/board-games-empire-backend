import { unsupportedOperation } from '@boardgamesempire/gateway-driver-contract';
import { status } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { firstValueFrom, lastValueFrom, of, throwError, toArray } from 'rxjs';
import { relayDriverAnswer } from './relay-driver-answer';

/** An error as a driver raises it to stand for a gRPC status: a plain Error with the code on it. */
const coded = (code: unknown, message = 'the driver said no') => Object.assign(new Error(message), { code });

/**
 * How a gRPC controller sends on what a driver answered. A remote
 * DataGateway's app and the coordinator, when it answers for a plugin
 * DataGateway, both serve the gateway gRPC protocol from a driver, so both
 * relay its answer the same way (#1083).
 */
describe('relayDriverAnswer', () => {
  it("sends the driver's frames as they are, and completes when it does (#1083)", async () => {
    const frames = [
      { correlationId: 'c', externalId: '13' },
      { correlationId: 'c', externalId: '822' },
    ];

    await expect(lastValueFrom(relayDriverAnswer(of(...frames)).pipe(toArray()))).resolves.toEqual(frames);
  });

  // A driver can't depend on Nest, so it says which gRPC status a failure is
  // with a code on the error (#1082).
  it("sends a driver's error that carries a gRPC status code as that status (#1083)", async () => {
    const refusal = await firstValueFrom(relayDriverAnswer(unsupportedOperation('ListMechanics'))).catch(
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(RpcException);
    expect((refusal as RpcException).getError()).toEqual({
      code: status.UNIMPLEMENTED,
      message: 'ListMechanics is not served by this DataGateway',
    });
  });

  // The statuses for a failed call run from CANCELLED (1) to UNAUTHENTICATED (16).
  it.each([status.CANCELLED, status.UNAUTHENTICATED])(
    'sends an error with code %d, an end of the range of failed-call statuses, as that status (#1083)',
    async (code) => {
      const refusal = await firstValueFrom(relayDriverAnswer(throwError(() => coded(code)))).catch(
        (err: unknown) => err,
      );

      expect(refusal).toBeInstanceOf(RpcException);
      expect((refusal as RpcException).getError()).toEqual({ code, message: 'the driver said no' });
    },
  );

  // OK (0) is no failure, and nothing above 16 or between two statuses is a
  // status at all. A system error's code is a string.
  it.each([status.OK, 17, 1.5, 418, 'ECONNREFUSED', undefined])(
    'passes an error whose code is %p through unchanged (#1083)',
    async (code) => {
      const failure = coded(code);

      await expect(firstValueFrom(relayDriverAnswer(throwError(() => failure)))).rejects.toBe(failure);
    },
  );

  // A DOMException carries a legacy numeric code of its own, which isn't a
  // gRPC status even when it falls among them: InvalidStateError's is 11,
  // OUT_OF_RANGE's number (#1082).
  //
  // In a server process a DOMException is an Error. Under Jest it is not:
  // the sandbox has an Error of its own, which the runtime's DOMException
  // doesn't extend, so a real one passes through whatever the relay does
  // with DOMExceptions. The spec stands in a DOMException that is to the
  // sandbox what the real one is to a server process.
  it('passes a DOMException through unchanged, though its code is the number of a status (#1083)', async () => {
    expect(new DOMException('The object is in an invalid state.', 'InvalidStateError').code).toBe(status.OUT_OF_RANGE);

    class DomExceptionThatIsAnError extends Error {
      readonly code = status.OUT_OF_RANGE;
    }

    const invalidState = new DomExceptionThatIsAnError('The object is in an invalid state.');
    const runtimeDomException = globalThis.DOMException;
    // The stand-in has none of the real class's statics, which the relay never reads.
    globalThis.DOMException = DomExceptionThatIsAnError as unknown as typeof DOMException;

    try {
      await expect(firstValueFrom(relayDriverAnswer(throwError(() => invalidState)))).rejects.toBe(invalidState);
    } finally {
      globalThis.DOMException = runtimeDomException;
    }
  });

  it('passes on something thrown that is no Error, whatever code it carries (#1083)', async () => {
    const thrown = { code: status.UNIMPLEMENTED, message: 'not an Error' };

    await expect(firstValueFrom(relayDriverAnswer(throwError(() => thrown)))).rejects.toBe(thrown);
  });
});
