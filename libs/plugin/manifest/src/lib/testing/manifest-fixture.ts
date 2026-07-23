import type { PluginManifest } from '../manifest.types.js';

/**
 * Deep-partial override shape for fixtures — nested objects merge one level
 * deep, arrays and scalars replace. Enough for the validator matrix without
 * dragging in a merge library.
 */
export interface PluginManifestOverrides extends Partial<
  Omit<PluginManifest, 'permissions' | 'events' | 'network' | 'storage' | 'jobs' | 'config'>
> {
  readonly permissions?: Partial<PluginManifest['permissions']>;
  readonly events?: Partial<PluginManifest['events']>;
  readonly network?: Partial<PluginManifest['network']>;
  readonly storage?: Partial<PluginManifest['storage']>;
  readonly jobs?: Partial<PluginManifest['jobs']>;
  readonly config?: Partial<PluginManifest['config']>;
}

/**
 * A fully valid baseline manifest (slug `demo-sink`) exercising every
 * section. Specs and later phases mutate from here; keeping the happy path
 * in ONE place means a rule change breaks exactly one fixture.
 */
export const buildPluginManifest = (overrides: PluginManifestOverrides = {}): PluginManifest => {
  const base: PluginManifest = {
    slug: 'demo-sink',
    version: '1.2.0',
    bgeCompat: '>=0.1.0',
    category: 'feedback-sink',
    scope: 'server',
    executionMode: 'in-process',
    displayName: { en: 'Demo Sink', de: 'Demo-Senke' },
    description: 'Reference plugin fixture used by the validator test matrix.',
    features: [
      {
        name: 'weekly-digest',
        displayName: { en: 'Weekly digest' },
        description: { en: 'Sends a weekly summary of collected feedback.' },
      },
    ],
    permissions: {
      declares: ['plugin:demo-sink:digest:manage'],
      checks: [
        {
          slug: 'plugin:demo-sink:digest:manage',
          required: true,
          reason: { en: 'Stores and manages the digest configuration it owns.' },
          consentScope: 'server',
        },
        {
          slug: 'feedback:read',
          required: false,
          reason: { en: 'Reads submitted feedback to compose the weekly digest.' },
          feature: 'weekly-digest',
          consentScope: 'server',
        },
      ],
    },
    events: {
      subscribes: ['feedback.created', 'feedback.*'],
      emits: ['plugin.demo-sink.digest-sent'],
    },
    topics: [
      {
        name: 'digest.preferences',
        displayName: { en: 'Digest preferences' },
        description: { en: 'Per-user digest delivery preferences.' },
        scope: 'user',
        payloadSchemaVersion: 1,
      },
    ],
    network: { outboundDomains: ['api.example.com'] },
    storage: {
      ownTables: ['plugin_demo_sink_digests'],
      readsCore: ['Feedback'],
      writesCore: [],
    },
    jobs: {
      queues: ['plugin:demo-sink:digest'],
      schedules: [{ name: 'weekly-digest', cron: '0 9 * * 1' }],
    },
    config: {
      schema: { type: 'object', properties: { webhookUrl: { type: 'string' } } },
      requiresHouseholdConfig: false,
    },
    metadataSchemaVersion: 1,
  };

  return {
    ...base,
    ...overrides,
    permissions: { ...base.permissions, ...overrides.permissions },
    events: { ...base.events, ...overrides.events },
    network: { ...base.network, ...overrides.network },
    storage: { ...base.storage, ...overrides.storage },
    jobs: { ...base.jobs, ...overrides.jobs },
    config: { ...base.config, ...overrides.config },
  };
};
