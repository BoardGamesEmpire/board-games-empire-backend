import { QuotaScope } from '@bge/database';
import { PoliciesGuard } from '@bge/permissions';
import { QuotaService, type QuotaView } from '@bge/quota';
import { createTestingModuleWithDb, type TestingModuleWithDb } from '@bge/testing';
import { BadRequestException } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { QuotasController } from './quotas.controller';

describe('QuotasController', () => {
  let moduleRef: TestingModuleWithDb;
  let controller: QuotasController;
  let quotas: jest.Mocked<Pick<QuotaService, 'getQuotas' | 'setQuota'>>;

  beforeEach(async () => {
    quotas = { getQuotas: jest.fn(), setQuota: jest.fn() };

    moduleRef = await createTestingModuleWithDb({
      controllers: [QuotasController],
      providers: [{ provide: QuotaService, useValue: quotas }],
      overrideGuards: [PoliciesGuard],
    });
    controller = moduleRef.module.get(QuotasController);
  });

  afterEach(() => jest.clearAllMocks());

  it('lists quotas the caller can read', async () => {
    quotas.getQuotas.mockResolvedValue([stubQuotaView()]);

    const result = await firstValueFrom(controller.list());

    expect(result).toEqual({ quotas: [stubQuotaView()] });
    expect(quotas.getQuotas).toHaveBeenCalledWith();
  });

  it('maps a "*" scopeId to the type-level default (null) when setting', async () => {
    quotas.setQuota.mockResolvedValue(stubQuotaView());

    const result = await firstValueFrom(
      controller.set(QuotaScope.Household, '*', 'household_member_count', { limit: '8' }),
    );

    expect(quotas.setQuota).toHaveBeenCalledWith(QuotaScope.Household, null, 'household_member_count', { limit: '8' });
    expect(result).toEqual({ message: 'Quota set', quota: stubQuotaView() });
  });

  it('passes a concrete scopeId through unchanged', async () => {
    quotas.setQuota.mockResolvedValue(stubQuotaView());

    await firstValueFrom(controller.set(QuotaScope.HouseholdMember, 'hm_1', 'storage_bytes', { limit: '1024' }));

    expect(quotas.setQuota).toHaveBeenCalledWith(QuotaScope.HouseholdMember, 'hm_1', 'storage_bytes', {
      limit: '1024',
    });
  });

  it('rejects an unknown resource before touching the service', () => {
    expect(() => controller.set(QuotaScope.User, 'user_1', 'bogus_resource', { limit: '1' })).toThrow(
      BadRequestException,
    );
    expect(quotas.setQuota).not.toHaveBeenCalled();
  });
});

function stubQuotaView(overrides?: Partial<QuotaView>): QuotaView {
  return {
    id: 'q_1',
    scope: QuotaScope.Household,
    scopeId: null,
    householdId: null,
    resource: 'household_member_count',
    limit: '8',
    softOverage: false,
    enforced: true,
    description: null,
    createdById: 'admin_1',
    updatedById: 'admin_1',

    ...overrides,
  };
}
