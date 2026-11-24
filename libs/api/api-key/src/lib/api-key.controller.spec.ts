import type { Actor, AuditContextService } from '@bge/actor-context';
import { RiskLevel } from '@bge/database';
import { isI18nMessage } from '@bge/i18n';
import { CHECK_POLICIES_KEY } from '@bge/permissions';
import { ForbiddenException } from '@nestjs/common';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { ApiKeyController } from './api-key.controller';
import type { ApiKeyService } from './api-key.service';

const USER_ID = 'user-1';

describe('ApiKeyController (#1417)', () => {
  let service: jest.Mocked<Pick<ApiKeyService, 'grantableFor'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;
  let controller: ApiKeyController;

  beforeEach(() => {
    service = {
      grantableFor: jest.fn().mockResolvedValue([
        {
          id: 'perm-manage-safe-http-policy',
          slug: 'manage:safe_http_policy',
          riskLevel: RiskLevel.Critical,
          pinnable: false,
        },
        { id: 'perm-read-ban', slug: 'read:household_ban', riskLevel: RiskLevel.Low, pinnable: true },
      ]),
    };
    auditContext = { getActor: jest.fn().mockReturnValue({ kind: 'user', userId: USER_ID } satisfies Actor) };
    controller = new ApiKeyController(
      service as unknown as ApiKeyService,
      auditContext as unknown as AuditContextService,
    );
  });

  describe('GET /api/api-keys/grantable', () => {
    it('maps each entry to slug, description marker, riskLevel and pinnable', async () => {
      const { permissions } = await firstValueFrom(controller.grantable());

      expect(service.grantableFor).toHaveBeenCalledWith(USER_ID);
      expect(permissions).toEqual([
        {
          slug: 'manage:safe_http_policy',
          description: expect.objectContaining({ key: 'permissions.manage:safe_http_policy' }),
          riskLevel: RiskLevel.Critical,
          pinnable: false,
        },
        {
          slug: 'read:household_ban',
          description: expect.objectContaining({ key: 'permissions.read:household_ban' }),
          riskLevel: RiskLevel.Low,
          pinnable: true,
        },
      ]);
      expect(permissions.every(({ description }) => isI18nMessage(description))).toBe(true);
      // The response interceptor renders markers inside plain objects only, so
      // each entry must be one, not a class instance.
      expect(permissions.every((entry) => Object.getPrototypeOf(entry) === Object.prototype)).toBe(true);
    });

    // A key acts for its owner but is not the owner: the list is what the
    // owner may hand a new key, so only the owner in person reads it.
    it('refuses an API-key actor', () => {
      auditContext.getActor.mockReturnValue({ kind: 'apiKey', apiKeyId: 'key-1', userId: USER_ID });

      expect(() => controller.grantable()).toThrow(ForbiddenException);
      expect(service.grantableFor).not.toHaveBeenCalled();
    });

    // An anonymous user holds no account of their own to hand a key, so only a
    // registered user signed in as themself reads the list (#1417).
    it("refuses an anonymous user's actor with 403", () => {
      auditContext.getActor.mockReturnValue({ kind: 'anonymous', userId: USER_ID });

      let status: number | undefined;
      try {
        controller.grantable();
      } catch (error) {
        status = error instanceof ForbiddenException ? error.getStatus() : undefined;
      }

      expect(status).toBe(403);
      expect(service.grantableFor).not.toHaveBeenCalled();
    });

    // Every signed-in user may list their own, so no policy gates the route.
    it('carries no policy check', () => {
      expect(Reflect.getMetadata(CHECK_POLICIES_KEY, ApiKeyController.prototype.grantable)).toBeUndefined();
    });
  });
});
