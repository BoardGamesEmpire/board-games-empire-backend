import { Controller, Get, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthCheck, HealthCheckService, HttpHealthIndicator } from '@nestjs/terminus';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { wrapSurrogate } from 'surrogate';

/**
 * @todo Identify why Surrogate Proxy is undefined
 */
@AllowAnonymous()
@Controller('health')
export class HealthController implements OnModuleInit {
  constructor(
    private configService: ConfigService,
    private health: HealthCheckService,
    private http: HttpHealthIndicator,
  ) {}
  @HealthCheck()
  @Get()
  httpCheck() {
    const healthMatrix = this.configService
      .get<string[]>('health.httpHealthCheckUrls', [])
      .map((urlEntry) => urlEntry.split('|'))
      .map(([name, url]) => {
        return async () => this.http.pingCheck(name, url);
      });

    return this.health.check(healthMatrix);
  }

  onModuleInit() {
    const wrapped = wrapSurrogate(this);

    wrapped.getSurrogate().registerPreHook('*check', 'accessCheck', {
      runConditions(this: HealthController) {
        return this.configService.get<boolean>('health.enableHealthChecks', true) === false;
      },
    });

    const handlers = wrapped.getSurrogate().getEventMap();

    Logger.log(JSON.stringify(handlers, null, 2), HealthController.name);
  }

  protected accessCheck() {
    throw new ServiceUnavailableException('Health checks are disabled via configuration');
  }
}
