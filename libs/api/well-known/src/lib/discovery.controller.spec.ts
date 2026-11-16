import { AuditContextService } from '@bge/actor-context';
import { CHECK_POLICIES_KEY } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { HEADERS_METADATA, INTERCEPTORS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import { SERVER_DISCOVERY_PATH } from './constants';
import { DiscoveryController } from './discovery.controller';
import { ServerDiscoveryDto } from './dto/server-discovery.dto';
import { SnakeCaseInterceptor } from './interceptors/snakecase.interceptor';
import { ServerDiscoveryService } from './server-discovery.service';

/**
 * The keys better-auth's decorators write, read off the decorators rather than
 * restated: the package does not export them, and these are the keys the
 * auth guard admits an unauthenticated request by.
 */
const ALLOW_ANONYMOUS_KEY = AllowAnonymous().KEY;
const OPTIONAL_AUTH_KEY = OptionalAuth().KEY;

describe('DiscoveryController (#78)', () => {
  let controller: DiscoveryController;
  let discovery: { getServerDiscovery: jest.Mock<Promise<ServerDiscoveryDto>, [string?]> };
  let auditContext: { getLocale: jest.Mock<string | null, []> };

  beforeEach(async () => {
    discovery = { getServerDiscovery: jest.fn().mockResolvedValue(new ServerDiscoveryDto()) };
    auditContext = { getLocale: jest.fn().mockReturnValue(null) };

    const { module } = await createTestingModuleWithDb({
      controllers: [DiscoveryController],
      providers: [
        { provide: ServerDiscoveryService, useValue: discovery },
        { provide: AuditContextService, useValue: auditContext },
      ],
    });

    controller = module.get(DiscoveryController);
  });

  it('serves the route the bge-identity document points at', () => {
    const base = Reflect.getMetadata(PATH_METADATA, DiscoveryController);
    const route = Reflect.getMetadata(PATH_METADATA, DiscoveryController.prototype.getServer);

    expect(`/api/${base}/${route}`).toBe(SERVER_DISCOVERY_PATH);
  });

  it('is private and revalidated on every use', () => {
    expect(Reflect.getMetadata(HEADERS_METADATA, DiscoveryController.prototype.getServer)).toContainEqual({
      name: 'Cache-Control',
      value: 'private, no-cache',
    });
  });

  it('requires a signed-in actor and no permission', () => {
    for (const key of [ALLOW_ANONYMOUS_KEY, OPTIONAL_AUTH_KEY]) {
      expect(Reflect.getMetadata(key, DiscoveryController)).toBeUndefined();
      expect(Reflect.getMetadata(key, DiscoveryController.prototype.getServer)).toBeUndefined();
    }

    expect(Reflect.getMetadata(CHECK_POLICIES_KEY, DiscoveryController.prototype.getServer)).toBeUndefined();
  });

  it('keeps the camelCase keys the rest of the API uses', () => {
    const interceptors = [
      ...(Reflect.getMetadata(INTERCEPTORS_METADATA, DiscoveryController) ?? []),
      ...(Reflect.getMetadata(INTERCEPTORS_METADATA, DiscoveryController.prototype.getServer) ?? []),
    ];

    expect(interceptors).not.toContain(SnakeCaseInterceptor);
  });

  it('passes the request locale to the service', async () => {
    auditContext.getLocale.mockReturnValue('de');

    await controller.getServer();

    expect(discovery.getServerDiscovery).toHaveBeenCalledWith('de');
  });

  it('passes no locale when the request names none, so the default applies', async () => {
    await controller.getServer();

    expect(discovery.getServerDiscovery).toHaveBeenCalledWith(undefined);
  });
});
