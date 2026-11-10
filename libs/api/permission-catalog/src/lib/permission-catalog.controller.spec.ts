import { Action, ResourceType, RiskLevel } from '@bge/database';
import { CHECK_POLICIES_KEY, PoliciesGuard, type AppAbility } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PermissionCatalogController } from './permission-catalog.controller';
import { PermissionCatalogService } from './permission-catalog.service';

describe('PermissionCatalogController', () => {
  let controller: PermissionCatalogController;
  const service = {
    getCatalog: jest.fn(),
    updatePermission: jest.fn(),
    updateRole: jest.fn(),
    addGrant: jest.fn(),
    revokeGrant: jest.fn(),
  };

  beforeEach(async () => {
    service.getCatalog.mockReset().mockResolvedValue({ permissions: [], roles: [] });
    service.updatePermission
      .mockReset()
      .mockResolvedValue({ permission: {}, warnings: [], consentDecisionsAffected: 0 });
    service.updateRole.mockReset().mockResolvedValue({ name: 'HouseholdMember' });
    service.addGrant.mockReset().mockResolvedValue({ grant: {}, warnings: [] });
    service.revokeGrant.mockReset().mockResolvedValue({ grant: null, warnings: [] });

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

  it("hands the role's name and its description to the service (#772)", async () => {
    await expect(controller.updateRole('HouseholdMember', { description: null })).resolves.toEqual({
      name: 'HouseholdMember',
    });

    expect(service.updateRole).toHaveBeenCalledWith('HouseholdMember', { description: null });
  });

  it("hands the role's name and the slug to the service to add or revoke a grant (#772)", async () => {
    await expect(controller.addGrant('HouseholdGuest', 'read:household')).resolves.toEqual({ grant: {}, warnings: [] });
    await expect(controller.revokeGrant('HouseholdGuest', 'read:household')).resolves.toEqual({
      grant: null,
      warnings: [],
    });

    expect(service.addGrant).toHaveBeenCalledWith('HouseholdGuest', 'read:household');
    expect(service.revokeGrant).toHaveBeenCalledWith('HouseholdGuest', 'read:household');
  });
});

describe('PermissionCatalogController policies', () => {
  // Only the Owner's manage:all reaches a write on Permission, Role or
  // RolePermission: no role holds a slug on any of them (#772). Staff read
  // every type, so they can read the permission catalog.
  it.each([
    ['getCatalog', Action.read, ResourceType.Permission],
    ['updatePermission', Action.update, ResourceType.Permission],
    ['updateRole', Action.update, ResourceType.Role],
    ['addGrant', Action.create, ResourceType.RolePermission],
    ['revokeGrant', Action.delete, ResourceType.RolePermission],
  ] as const)('%s requires %s on %s', (method, action, subject) => {
    const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, PermissionCatalogController.prototype[method]) as Array<
      (ability: AppAbility) => boolean
    >;
    const can = jest.fn().mockReturnValue(true);

    expect(handlers).toHaveLength(1);
    handlers[0]({ can } as unknown as AppAbility);

    expect(can).toHaveBeenCalledTimes(1);
    expect(can).toHaveBeenCalledWith(action, subject);
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
    const refusals = {
      responses: {
        '409': { content: { 'application/json': { schema: schema('CatalogErrorDto') } } },
        '422': { content: { 'application/json': { schema: schema('CatalogEditRefusalDto') } } },
      },
    };
    expect(document).toMatchObject({
      paths: {
        '/permission-catalog/permissions/{slug}': { patch: refusals },
        '/permission-catalog/roles/{name}/grants/{slug}': {
          put: {
            responses: {
              ...refusals.responses,
              '200': { content: { 'application/json': { schema: schema('GrantEditDto') } } },
            },
          },
          delete: {
            responses: {
              ...refusals.responses,
              '200': { content: { 'application/json': { schema: schema('GrantEditDto') } } },
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
