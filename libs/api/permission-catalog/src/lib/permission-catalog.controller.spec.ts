import { Action, ResourceType, RiskLevel } from '@bge/database';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PermissionCatalogController } from './permission-catalog.controller';
import { PermissionCatalogService } from './permission-catalog.service';

describe('PermissionCatalogController', () => {
  let controller: PermissionCatalogController;
  const service = { getCatalog: jest.fn(), updatePermission: jest.fn() };

  beforeEach(async () => {
    service.getCatalog.mockReset().mockResolvedValue({ permissions: [], roles: [] });
    service.updatePermission
      .mockReset()
      .mockResolvedValue({ permission: {}, warnings: [], consentDecisionsAffected: 0 });

    const { module } = await createTestingModuleWithDb({
      providers: [{ provide: PermissionCatalogService, useValue: service }],
      controllers: [PermissionCatalogController],
      overrideGuards: [PoliciesGuard],
    });

    controller = module.get(PermissionCatalogController);
  });

  it('answers the permission catalog as the service reads it (#772)', async () => {
    await expect(controller.getCatalog()).resolves.toEqual({ permissions: [], roles: [] });
  });

  it('hands the slug and the edit to the service (#772)', async () => {
    await expect(controller.updatePermission('update:event', { riskLevel: RiskLevel.High })).resolves.toEqual({
      permission: {},
      warnings: [],
      consentDecisionsAffected: 0,
    });

    expect(service.updatePermission).toHaveBeenCalledWith('update:event', { riskLevel: RiskLevel.High });
  });
});

describe('PermissionCatalogController policies', () => {
  // Only the Owner's manage:all reaches a write on Permission: no role holds a
  // slug on it (#772). Staff read every type, so they can read it.
  it.each([
    ['getCatalog', Action.read],
    ['updatePermission', Action.update],
  ] as const)('%s requires %s on Permission', (method, action) => {
    const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, PermissionCatalogController.prototype[method]) as Array<
      (ability: AppAbility) => boolean
    >;
    const can = jest.fn().mockReturnValue(true);

    expect(handlers).toHaveLength(1);
    handlers[0]({ can } as unknown as AppAbility);

    expect(can).toHaveBeenCalledTimes(1);
    expect(can).toHaveBeenCalledWith(action, ResourceType.Permission);
  });
});

describe('PermissionCatalogController OpenAPI (#772)', () => {
  // The client's screens render each refusal problem from its `kind` and
  // fields (client#821), so the 422 body is documented, not only described.
  it('documents the 422 refusal body, with every problem by its kind', async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [{ provide: PermissionCatalogService, useValue: {} }],
      controllers: [PermissionCatalogController],
      overrideGuards: [PoliciesGuard],
    });
    const app = module.createNestApplication();
    await app.init();
    const document: unknown = JSON.parse(
      JSON.stringify(SwaggerModule.createDocument(app, new DocumentBuilder().build())),
    );
    await app.close();

    const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    expect(document).toMatchObject({
      paths: {
        '/permission-catalog/permissions/{slug}': {
          patch: {
            responses: {
              '409': { content: { 'application/json': { schema: schema('CatalogErrorDto') } } },
              '422': { content: { 'application/json': { schema: schema('CatalogEditRefusalDto') } } },
            },
          },
        },
      },
      components: {
        schemas: {
          CatalogEditRefusalDto: {
            properties: {
              code: { enum: ['CATALOG_ENTRY_REFUSED', 'CATALOG_OWNER_LOCKOUT'] },
              problems: {
                type: 'array',
                items: {
                  discriminator: {
                    propertyName: 'kind',
                    mapping: {
                      template: schema('TemplateProblemDto').$ref,
                      'fails-open': schema('RoleProblemDto').$ref,
                      'reads-past-reach': schema('ReadsPastReachProblemDto').$ref,
                      'query-rejected': schema('QueryRejectedProblemDto').$ref,
                    },
                  },
                },
              },
            },
          },
          QueryRejectedProblemDto: {
            properties: { kind: { enum: ['query-rejected'] }, slug: {}, message: {} },
          },
        },
      },
    });
  });
});
