import type { SafeHttpErrorCode } from '@bge/secure-http';
import {
  OutboundNetworkError,
  RedirectLimitExceededError,
  ResponseTooLargeError,
  SafeHttpError,
  SecureHttpService,
} from '@bge/secure-http';
import { Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { HealthIndicatorService } from '@nestjs/terminus';

/**
 * How long one HTTP check waits, redirects included. `/health` is read by a
 * person or a monitor, so a target that does not answer within this should
 * show as down, not hold the report open.
 */
const CHECK_TIMEOUT_MS = 5000;

/**
 * Terminus health indicator for one operator-configured HTTP target.
 *
 * HTTP checks go through the outbound HTTP policy like every other outbound
 * request, so a private target (a service on the same network, say) needs the
 * policy to allow it, and a refusal shows as down with its code. Terminus's
 * own HTTP indicator sent the request on a plain axios client and bypassed the
 * policy (#1509).
 *
 * The check asks whether the target answers, not whether it serves the page.
 * Redirects are followed under the same policy, up to the policy's redirect
 * limit, and the last answer counts: 200 through 399 is up. A redirect past
 * the limit is a 3xx answer, so it is up too; a redirect to a target the
 * policy refuses is down. The body is read as bytes and dropped, and a body
 * past the outbound HTTP policy's response limit is up, since its status line
 * and headers had already arrived.
 *
 * One time limit covers the whole chain. The policy's address lookup before
 * each hop takes no signal, so the resolver's own timeouts bound that part.
 */
@Injectable()
export class HttpTargetHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly secureHttp: SecureHttpService,
  ) {}

  async check(key: string, url: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    // request() gives each hop its own `timeoutMs`; the signal is what holds
    // the redirect chain to one limit.
    const deadline = AbortSignal.timeout(CHECK_TIMEOUT_MS);

    try {
      const { status } = await this.secureHttp.request(url, {
        method: 'GET',
        responseType: 'arraybuffer',
        timeoutMs: CHECK_TIMEOUT_MS,
        signal: deadline,
      });

      return status >= 200 && status < 400 ? indicator.up() : indicator.down({ statusCode: status });
    } catch (error) {
      if (error instanceof RedirectLimitExceededError || error instanceof ResponseTooLargeError) {
        return indicator.up();
      }

      // A refusal or a network failure is the target's state, so it is a down
      // result. Anything else is a bug here and must not read as an outage.
      if (error instanceof SafeHttpError) {
        return indicator.down({ code: this.codeFor(error, deadline) });
      }

      throw error;
    }
  }

  /**
   * The deadline cuts a later hop off through the caller's signal, which
   * request() reports as a network error. It is the check's time limit, so it
   * reads as one.
   */
  private codeFor(error: SafeHttpError, deadline: AbortSignal): SafeHttpErrorCode {
    return error instanceof OutboundNetworkError && deadline.aborted ? 'REQUEST_TIMEOUT' : error.code;
  }
}
