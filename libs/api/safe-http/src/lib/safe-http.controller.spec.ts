import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { firstValueFrom } from 'rxjs';
import type { UpdateSafeHttpPolicyDto } from './dto/update-safe-http-policy.dto';
import { SafeHttpController } from './safe-http.controller';
import { SafeHttpService } from './safe-http.service';

describe('SafeHttpController', () => {
  let controller: SafeHttpController;
  let safeHttpService: jest.Mocked<Pick<SafeHttpService, 'getPolicy' | 'updatePolicy'>>;

  beforeEach(async () => {
    safeHttpService = {
      getPolicy: jest.fn(),
      updatePolicy: jest.fn(),
    };

    const { module } = await createTestingModuleWithDb({
      controllers: [SafeHttpController],
      providers: [{ provide: SafeHttpService, useValue: safeHttpService }],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(SafeHttpController);
  });

  describe('GET /safe-http-policy', () => {
    it('wraps the service result in `{ policy }`', async () => {
      const fake = { id: 'policy-1', defaultTimeoutMs: 10_000 } as Awaited<ReturnType<SafeHttpService['getPolicy']>>;
      safeHttpService.getPolicy.mockResolvedValue(fake);

      const result = await firstValueFrom(controller.getPolicy());
      expect(result).toEqual({ policy: fake });
    });
  });

  describe('PATCH /safe-http-policy/:id', () => {
    it('delegates id and DTO to the service and wraps the result', async () => {
      const dto: UpdateSafeHttpPolicyDto = { defaultTimeoutMs: 15_000 };
      const updated = { id: 'policy-1', defaultTimeoutMs: 15_000 } as Awaited<
        ReturnType<SafeHttpService['updatePolicy']>
      >;

      safeHttpService.updatePolicy.mockResolvedValue(updated);

      const result = await firstValueFrom(controller.updatePolicy('policy-1', dto));

      expect(safeHttpService.updatePolicy).toHaveBeenCalledWith('policy-1', dto);
      expect(result).toEqual({ policy: updated });
    });
  });
});
