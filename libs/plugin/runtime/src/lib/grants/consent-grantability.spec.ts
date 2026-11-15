import { PluginGrantScope, RiskLevel } from '@bge/database';
import { UNIT_BOUND_RULES } from '@bge/testing';
import type { NormalizedPermissionRequest } from '@boardgamesempire/plugin-manifest';
import type { ConsentCatalogPermission } from '../consent/consent-catalog-flags';
import { consentUngrantableCause } from './consent-grantability';

describe('consentUngrantableCause (#1150)', () => {
  const request = (
    canonicalSlug: string,
    origin: NormalizedPermissionRequest['origin'] = 'core',
  ): Pick<NormalizedPermissionRequest, 'canonicalSlug' | 'origin'> => ({ canonicalSlug, origin });

  const corePermission = (
    slug: string,
    overrides: Partial<ConsentCatalogPermission> = {},
  ): ConsentCatalogPermission => ({
    slug,
    action: 'create',
    fields: [],
    inverted: false,
    ...UNIT_BOUND_RULES.Household,
    ...overrides,
  });

  const DECLARED = 'plugin|demo-sink|read:digest';

  it('a core requested permission with a live row that binds the household, at household scope, is grantable', () => {
    expect(
      consentUngrantableCause({
        check: request('create:event'),
        decidingScope: PluginGrantScope.Household,
        corePermission: corePermission('create:event'),
        catalogRisk: RiskLevel.Low,
        source: 'active',
      }),
    ).toBeNull();
  });

  it('a core requested permission with no live row is ungrantable: no_catalog_row', () => {
    expect(
      consentUngrantableCause({
        check: request('create:event'),
        decidingScope: PluginGrantScope.Household,
        corePermission: undefined,
        catalogRisk: undefined,
        source: 'active',
      }),
    ).toBe('no_catalog_row');
  });

  it('a core requested permission with no live row stays ungrantable under a staged manifest', () => {
    expect(
      consentUngrantableCause({
        check: request('create:event'),
        decidingScope: PluginGrantScope.Household,
        corePermission: undefined,
        catalogRisk: undefined,
        source: 'staged',
      }),
    ).toBe('no_catalog_row');
  });

  it('a core requested permission on the all subject is ungrantable: wildcard_subject', () => {
    expect(
      consentUngrantableCause({
        check: request('read:everything'),
        decidingScope: PluginGrantScope.Server,
        corePermission: corePermission('read:everything', { subject: 'all' }),
        catalogRisk: RiskLevel.High,
        source: 'active',
      }),
    ).toBe('wildcard_subject');
  });

  it('a core requested permission with no conditions at household scope is ungrantable: unbound_unit_scope (#591)', () => {
    expect(
      consentUngrantableCause({
        check: request('create:event'),
        decidingScope: PluginGrantScope.Household,
        corePermission: corePermission('create:event', { conditions: null }),
        catalogRisk: RiskLevel.Low,
        source: 'active',
      }),
    ).toBe('unbound_unit_scope');
  });

  it('the same requested permission at server scope is grantable, since server consent needs no unit binding', () => {
    expect(
      consentUngrantableCause({
        check: request('create:event'),
        decidingScope: PluginGrantScope.Server,
        corePermission: corePermission('create:event', { conditions: null }),
        catalogRisk: RiskLevel.Low,
        source: 'active',
      }),
    ).toBeNull();
  });

  it('core plugin administration is ungrantable: categorical_exclusion, even with a live row', () => {
    expect(
      consentUngrantableCause({
        check: request('manage:plugin'),
        decidingScope: PluginGrantScope.Server,
        corePermission: corePermission('manage:plugin', { action: 'manage', subject: 'Plugin', conditions: null }),
        catalogRisk: RiskLevel.High,
        source: 'active',
      }),
    ).toBe('categorical_exclusion');
  });

  it('a declared requested permission with no catalog row under the active manifest is ungrantable: no_catalog_row', () => {
    expect(
      consentUngrantableCause({
        check: request(DECLARED, 'plugin'),
        decidingScope: PluginGrantScope.Household,
        corePermission: undefined,
        catalogRisk: undefined,
        source: 'active',
      }),
    ).toBe('no_catalog_row');
  });

  it('a declared requested permission with no catalog row under a staged manifest is grantable: activation creates the row', () => {
    expect(
      consentUngrantableCause({
        check: request(DECLARED, 'plugin'),
        decidingScope: PluginGrantScope.Household,
        corePermission: undefined,
        catalogRisk: undefined,
        source: 'staged',
      }),
    ).toBeNull();
  });

  it('a declared requested permission with a catalog row is grantable', () => {
    expect(
      consentUngrantableCause({
        check: request(DECLARED, 'plugin'),
        decidingScope: PluginGrantScope.Household,
        corePermission: undefined,
        catalogRisk: RiskLevel.Low,
        source: 'active',
      }),
    ).toBeNull();
  });

  it('a declared requested permission whose bare slug is manage:all is ungrantable: categorical_exclusion', () => {
    expect(
      consentUngrantableCause({
        check: request('plugin|demo-sink|manage:all', 'plugin'),
        decidingScope: PluginGrantScope.Household,
        corePermission: undefined,
        catalogRisk: RiskLevel.Low,
        source: 'active',
      }),
    ).toBe('categorical_exclusion');
  });

  it('a declared requested permission that mimics plugin administration is ungrantable even when staged', () => {
    expect(
      consentUngrantableCause({
        check: request('plugin|demo-sink|manage:plugin', 'plugin'),
        decidingScope: PluginGrantScope.Household,
        corePermission: undefined,
        catalogRisk: undefined,
        source: 'staged',
      }),
    ).toBe('categorical_exclusion');
  });

  it('a declared requested permission under an all: subject path is ungrantable: categorical_exclusion', () => {
    expect(
      consentUngrantableCause({
        check: request('plugin|demo-sink|read:all:digest', 'plugin'),
        decidingScope: PluginGrantScope.Household,
        corePermission: undefined,
        catalogRisk: RiskLevel.Low,
        source: 'active',
      }),
    ).toBe('categorical_exclusion');
  });
});
