import { SafeHttpError, SecureHttpService } from '@bge/secure-http';
import { Injectable } from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import { HealthIndicatorService } from '@nestjs/terminus';

/**
 * How long one HTTP check waits. `/health` is read by a person or a monitor,
 * so a target that does not answer within this should show as down, not hold
 * the report open.
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
 * Redirects are followed under the same policy, and the last answer counts:
 * 200 through 399 is up, since the check asks whether the target answers, not
 * whether it serves the page. A redirect to a target the policy refuses is
 * down. The body is read as bytes and dropped.
 */
@Injectable()
export class HttpTargetHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly secureHttp: SecureHttpService,
  ) {}

  async check(key: string, url: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const { status } = await this.secureHttp.request(url, {
        method: 'GET',
        responseType: 'arraybuffer',
        timeoutMs: CHECK_TIMEOUT_MS,
      });

      return status >= 200 && status < 400 ? indicator.up() : indicator.down({ statusCode: status });
    } catch (error) {
      // A refusal or a network failure is the target's state, so it is a down
      // result. Anything else is a bug here and must not read as an outage.
      if (error instanceof SafeHttpError) {
        return indicator.down({ code: error.code });
      }

      throw error;
    }
  }
}
