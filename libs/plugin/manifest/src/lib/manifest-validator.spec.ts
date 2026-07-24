import { ManifestErrorCode, ManifestWarningCode, PluginManifestValidationError } from './errors.js';
import { ManifestValidationOptions, validatePluginManifest } from './manifest-validator.js';
import type { PluginManifest } from './manifest.types.js';
import { buildPluginManifest, PluginManifestOverrides } from './testing/manifest-fixture.js';

const options: ManifestValidationOptions = { bgeVersion: '0.3.0', defaultLocale: 'en' };

const expectRejection = (
  input: unknown,
  code: ManifestErrorCode,
  opts: ManifestValidationOptions = options,
): PluginManifestValidationError => {
  try {
    validatePluginManifest(input, opts);
  } catch (error) {
    expect(error).toBeInstanceOf(PluginManifestValidationError);
    const validationError = error as PluginManifestValidationError;
    expect(validationError.has(code)).toBe(true);

    return validationError;
  }

  throw new Error(`Expected validation to reject with ${code}`);
};

const manifest = (overrides: PluginManifestOverrides = {}): PluginManifest => buildPluginManifest(overrides);

/** Indexed access under `noUncheckedIndexedAccess` — fails loudly instead of asserting non-null. */
const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`Fixture is missing expected element at index ${index}`);
  }

  return item;
};

describe('validatePluginManifest', () => {
  describe('happy path', () => {
    it('accepts the baseline fixture and returns the parsed manifest', () => {
      const result = validatePluginManifest(manifest(), options);

      expect(result.manifest.slug).toBe('demo-sink');
      expect(result.warnings).toHaveLength(0);
    });

    it('defaults consentScope to server on normalized permission checks', () => {
      const input = manifest();
      const first = at(input.permissions.checks, 0);
      input.permissions.checks = [
        { slug: first.slug, required: first.required, reason: first.reason },
        ...input.permissions.checks.slice(1),
      ];

      const result = validatePluginManifest(input, options);

      expect(result.permissionChecks[0]?.consentScope).toBe('server');
    });

    it('partitions external permission checks for the install pipeline without validating their existence', () => {
      const result = validatePluginManifest(manifest(), options);

      expect(result.externalPermissionChecks).toEqual(['feedback:read']);
    });
  });

  describe('structural rejection (SCHEMA_INVALID)', () => {
    it('rejects non-object input', () => {
      expectRejection('not a manifest', ManifestErrorCode.SCHEMA_INVALID);
    });

    it('rejects unknown top-level keys (strict object)', () => {
      expectRejection({ ...manifest(), sneaky: true }, ManifestErrorCode.SCHEMA_INVALID);
    });

    it('rejects an invalid category enum value with the offending path', () => {
      const error = expectRejection({ ...manifest(), category: 'time-machine' }, ManifestErrorCode.SCHEMA_INVALID);

      expect(error.issues.some((issue) => issue.path === 'category')).toBe(true);
    });

    it('rejects an invalid executionMode', () => {
      expectRejection({ ...manifest(), executionMode: 'kernel-module' }, ManifestErrorCode.SCHEMA_INVALID);
    });

    it('rejects a malformed slug', () => {
      expectRejection({ ...manifest(), slug: 'Demo_Sink!' }, ManifestErrorCode.SCHEMA_INVALID);
    });

    it('rejects a non-integer metadataSchemaVersion', () => {
      expectRejection({ ...manifest(), metadataSchemaVersion: 1.5 }, ManifestErrorCode.SCHEMA_INVALID);
    });

    it('rejects an invalid topic payloadSchemaVersion', () => {
      const input = manifest();
      expectRejection(
        { ...input, topics: [{ ...at(input.topics, 0), payloadSchemaVersion: 0 }] },
        ManifestErrorCode.SCHEMA_INVALID,
      );
    });

    it('renders structural paths in the same bracket notation as semantic issues', () => {
      const input = manifest();
      const error = expectRejection(
        { ...input, topics: [{ ...at(input.topics, 0), payloadSchemaVersion: 0 }] },
        ManifestErrorCode.SCHEMA_INVALID,
      );

      expect(error.issues.some((issue) => issue.path === 'topics[0].payloadSchemaVersion')).toBe(true);
    });
  });

  describe('version and compatibility', () => {
    it('rejects a non-semver version', () => {
      expectRejection(manifest({ version: 'one.two' }), ManifestErrorCode.VERSION_INVALID);
    });

    it('rejects an invalid bgeCompat range', () => {
      expectRejection(manifest({ bgeCompat: '>=not-a-version' }), ManifestErrorCode.BGE_COMPAT_INVALID_RANGE);
    });

    it('rejects when the running BGE version does not satisfy bgeCompat', () => {
      expectRejection(manifest({ bgeCompat: '>=9.0.0' }), ManifestErrorCode.BGE_COMPAT_UNSATISFIED);
    });

    it('accepts a satisfied range against a prerelease BGE version', () => {
      const result = validatePluginManifest(manifest(), { ...options, bgeVersion: '0.3.0-beta.1' });

      expect(result.manifest.bgeCompat).toBe('>=0.1.0');
    });
  });

  describe('localization rules', () => {
    it('rejects a localized map missing the configured default locale', () => {
      expectRejection(manifest({ displayName: { de: 'Nur Deutsch' } }), ManifestErrorCode.LOCALE_DEFAULT_MISSING);
    });

    it('matches the default locale case-insensitively (BCP 47 canonical comparison)', () => {
      const result = validatePluginManifest(manifest({ displayName: { EN: 'Hello' } }), options);

      expect(result.manifest.displayName).toEqual({ EN: 'Hello' });
    });

    it('throws RangeError on a malformed defaultLocale option — server misconfiguration, not a manifest issue', () => {
      expect(() => validatePluginManifest(manifest(), { ...options, defaultLocale: 'de_DE' })).toThrow(RangeError);
    });

    it('throws RangeError on a malformed bgeVersion option — server misconfiguration, not a manifest issue', () => {
      expect(() => validatePluginManifest(manifest(), { ...options, bgeVersion: 'not-a-version' })).toThrow(RangeError);
    });

    it('rejects malformed BCP 47 locale keys', () => {
      const error = expectRejection(
        manifest({ description: { en: 'Fine.', 'de_DE!': 'Kaputt' } }),
        ManifestErrorCode.LOCALE_TAG_INVALID,
      );

      expect(error.issues.some((issue) => issue.path === 'description.de_DE!')).toBe(true);
    });

    it('applies locale rules to nested localized fields (feature displayName)', () => {
      const input = manifest();
      input.features = [{ ...at(input.features, 0), displayName: { fr: 'Résumé' } }];

      expectRejection(input, ManifestErrorCode.LOCALE_DEFAULT_MISSING);
    });
  });

  describe('permission namespacing', () => {
    it('rejects a declares entry outside the plugin namespace', () => {
      expectRejection(
        manifest({ permissions: { declares: ['game:read'], checks: [] } }),
        ManifestErrorCode.PERMISSION_DECLARE_NAMESPACE,
      );
    });

    it('rejects a declares entry that is only the bare prefix', () => {
      expectRejection(
        manifest({ permissions: { declares: ['plugin:demo-sink:'], checks: [] } }),
        ManifestErrorCode.PERMISSION_DECLARE_NAMESPACE,
      );
    });

    it('rejects duplicate declares entries', () => {
      expectRejection(
        manifest({
          permissions: { declares: ['plugin:demo-sink:digest:manage', 'plugin:demo-sink:digest:manage'], checks: [] },
        }),
        ManifestErrorCode.PERMISSION_DECLARE_DUPLICATE,
      );
    });

    it('rejects a check in another plugin namespace', () => {
      const input = manifest();
      input.permissions.checks = [
        { slug: 'plugin:other-plugin:secrets:read', required: false, reason: 'Reads the other plugin secrets store.' },
      ];

      expectRejection(input, ManifestErrorCode.PERMISSION_CHECK_FOREIGN_NAMESPACE);
    });

    it('rejects an own-namespace check that was never declared', () => {
      const input = manifest();
      input.permissions.checks = [
        {
          slug: 'plugin:demo-sink:undeclared:thing',
          required: false,
          reason: 'Uses a permission it forgot to declare.',
        },
      ];

      expectRejection(input, ManifestErrorCode.PERMISSION_CHECK_UNDECLARED);
    });

    it.each([
      'read:public_content',
      'create:feedback_report',
      'read:event_occurrence',
      'update:event_attendee:status:self',
      'manage:quota:household_member',
    ])("accepts core permission slug '%s' (underscore segments, matching the seeded vocabulary)", (slug) => {
      const input = manifest();
      input.permissions.checks = [
        { slug, required: false, reason: `Requests the seeded ${slug} permission for its digest.` },
      ];

      const result = validatePluginManifest(input, options);

      expect(result.externalPermissionChecks).toEqual([slug]);
    });

    it('rejects a check slug that matches no known shape', () => {
      const input = manifest();
      input.permissions.checks = [
        { slug: 'NotAPermissionSlug', required: false, reason: 'Shaped like nothing recognizable here.' },
      ];

      expectRejection(input, ManifestErrorCode.PERMISSION_CHECK_SHAPE);
    });

    it('rejects duplicate check slugs', () => {
      const input = manifest();
      input.permissions.checks = [
        { slug: 'feedback:read', required: false, reason: 'Reads submitted feedback for the digest.' },
        { slug: 'feedback:read', required: false, reason: 'Reads submitted feedback for the digest.' },
      ];

      expectRejection(input, ManifestErrorCode.PERMISSION_CHECK_DUPLICATE);
    });
  });

  describe('reason quality', () => {
    it('rejects a reason below the minimum length', () => {
      const input = manifest();
      input.permissions.checks = [{ slug: 'feedback:read', required: false, reason: 'short' }];

      expectRejection(input, ManifestErrorCode.REASON_TRIVIAL);
    });

    it('rejects low-effort reason text per locale with the locale in the path', () => {
      const input = manifest();
      input.permissions.checks = [
        {
          slug: 'feedback:read',
          required: false,
          reason: { en: 'Reads submitted feedback for the digest.', de: 'todo' },
        },
      ];

      const error = expectRejection(input, ManifestErrorCode.REASON_TRIVIAL);

      expect(error.issues.some((issue) => issue.path === 'permissions.checks[0].reason.de')).toBe(true);
    });

    it('honors a custom minReasonLength', () => {
      const input = manifest();
      input.permissions.checks = [{ slug: 'feedback:read', required: false, reason: 'Reads feedback rows.' }];

      const result = validatePluginManifest(input, { ...options, minReasonLength: 5 });

      expect(result.externalPermissionChecks).toContain('feedback:read');
    });
  });

  describe('feature references', () => {
    it('rejects a check referencing an unknown feature', () => {
      const input = manifest();
      input.permissions.checks = [
        {
          slug: 'feedback:read',
          required: false,
          reason: 'Reads submitted feedback for the digest.',
          feature: 'ghost-feature',
        },
      ];

      expectRejection(input, ManifestErrorCode.FEATURE_REF_UNKNOWN);
    });

    it('rejects duplicate feature names', () => {
      const input = manifest();
      input.features = [at(input.features, 0), { ...at(input.features, 0) }];

      expectRejection(input, ManifestErrorCode.FEATURE_NAME_DUPLICATE);
    });
  });

  describe('network.outboundDomains', () => {
    it.each([
      'https://api.example.com',
      'api.example.com:8443',
      '*.example.com',
      '192.168.0.10',
      'API.example.com',
      'localhost',
    ])("rejects '%s' as an outbound domain", (domain) => {
      expectRejection(manifest({ network: { outboundDomains: [domain] } }), ManifestErrorCode.OUTBOUND_DOMAIN_INVALID);
    });

    it('rejects duplicated domains', () => {
      expectRejection(
        manifest({ network: { outboundDomains: ['api.example.com', 'api.example.com'] } }),
        ManifestErrorCode.OUTBOUND_DOMAIN_DUPLICATE,
      );
    });

    it("accepts the literal 'configured' and punycode FQDNs", () => {
      validatePluginManifest(manifest({ network: { outboundDomains: 'configured' } }), options);
      validatePluginManifest(manifest({ network: { outboundDomains: ['example.xn--p1ai'] } }), options);
      validatePluginManifest(manifest({ network: { outboundDomains: ['xn--bcher-kva.example'] } }), options);
    });
  });

  describe('topics', () => {
    it('rejects a structurally invalid topic name', () => {
      const input = manifest();
      expectRejection(
        { ...input, topics: [{ ...at(input.topics, 0), name: 'Digest..Prefs' }] },
        ManifestErrorCode.SCHEMA_INVALID,
      );
    });

    it('rejects duplicate topic names', () => {
      const input = manifest();
      input.topics = [at(input.topics, 0), { ...at(input.topics, 0) }];

      expectRejection(input, ManifestErrorCode.TOPIC_NAME_DUPLICATE);
    });
  });

  describe('events', () => {
    it('rejects duplicate emitted events', () => {
      expectRejection(
        manifest({
          events: { subscribes: [], emits: ['plugin.demo-sink.digest-sent', 'plugin.demo-sink.digest-sent'] },
        }),
        ManifestErrorCode.EVENT_EMIT_DUPLICATE,
      );
    });

    it('rejects duplicate subscribe patterns', () => {
      expectRejection(
        manifest({ events: { subscribes: ['feedback.created', 'feedback.created'], emits: [] } }),
        ManifestErrorCode.EVENT_SUBSCRIBE_DUPLICATE,
      );
    });

    it('rejects an emitted event outside the plugin namespace', () => {
      expectRejection(
        manifest({ events: { subscribes: [], emits: ['game.import.completed'] } }),
        ManifestErrorCode.EVENT_EMIT_NAMESPACE,
      );
    });

    it('rejects a malformed emitted event name', () => {
      expectRejection(
        manifest({ events: { subscribes: [], emits: ['plugin.demo-sink.'] } }),
        ManifestErrorCode.EVENT_NAME_INVALID,
      );
    });

    it('rejects a malformed subscribe pattern structurally', () => {
      expectRejection(manifest({ events: { subscribes: ['..broken'], emits: [] } }), ManifestErrorCode.SCHEMA_INVALID);
    });
  });

  describe('jobs', () => {
    it('rejects a queue outside the plugin namespace', () => {
      expectRejection(manifest({ jobs: { queues: ['digest'], schedules: [] } }), ManifestErrorCode.QUEUE_NAMESPACE);
    });

    it('rejects duplicate queues', () => {
      expectRejection(
        manifest({ jobs: { queues: ['plugin:demo-sink:digest', 'plugin:demo-sink:digest'], schedules: [] } }),
        ManifestErrorCode.QUEUE_DUPLICATE,
      );
    });

    it('rejects an invalid cron expression', () => {
      expectRejection(
        manifest({ jobs: { queues: [], schedules: [{ name: 'weekly-digest', cron: 'every monday at nine' }] } }),
        ManifestErrorCode.CRON_INVALID,
      );
    });

    it('accepts a 6-field cron expression', () => {
      validatePluginManifest(
        manifest({ jobs: { queues: [], schedules: [{ name: 'weekly-digest', cron: '0 0 9 * * 1' }] } }),
        options,
      );
    });

    it('rejects invalid and duplicate schedule names', () => {
      const error = expectRejection(
        manifest({
          jobs: {
            queues: [],
            schedules: [
              { name: 'Weekly Digest', cron: '0 9 * * 1' },
              { name: 'sweep', cron: '0 9 * * 1' },
              { name: 'sweep', cron: '0 9 * * 1' },
            ],
          },
        }),
        ManifestErrorCode.SCHEDULE_NAME_INVALID,
      );

      expect(error.has(ManifestErrorCode.SCHEDULE_NAME_DUPLICATE)).toBe(true);
    });
  });

  describe('storage declarations (D-H: shape-enforced, execution-inert)', () => {
    it('rejects an own table missing the plugin_<slug>_ prefix', () => {
      expectRejection(
        manifest({ storage: { ownTables: ['digests'], readsCore: [], writesCore: [] } }),
        ManifestErrorCode.OWN_TABLE_PREFIX,
      );
    });

    it('rejects an own table with a non-snake-case suffix', () => {
      expectRejection(
        manifest({ storage: { ownTables: ['plugin_demo_sink_MyDigests'], readsCore: [], writesCore: [] } }),
        ManifestErrorCode.OWN_TABLE_PREFIX,
      );
    });

    it('rejects duplicate own tables', () => {
      expectRejection(
        manifest({
          storage: {
            ownTables: ['plugin_demo_sink_digests', 'plugin_demo_sink_digests'],
            readsCore: [],
            writesCore: [],
          },
        }),
        ManifestErrorCode.OWN_TABLE_DUPLICATE,
      );
    });

    it('rejects a non-PascalCase core model reference structurally', () => {
      expectRejection(
        manifest({ storage: { ownTables: [], readsCore: ['feedback rows'], writesCore: [] } }),
        ManifestErrorCode.SCHEMA_INVALID,
      );
    });
  });

  describe('updateCheck', () => {
    it('rejects a non-https update check URL', () => {
      expectRejection(
        manifest({ updateCheck: { url: 'http://plugin.example.com/latest.json' } }),
        ManifestErrorCode.UPDATE_CHECK_URL_INVALID,
      );
    });

    it('rejects an unparseable update check URL', () => {
      expectRejection(manifest({ updateCheck: { url: 'not a url' } }), ManifestErrorCode.UPDATE_CHECK_URL_INVALID);
    });
  });

  describe('warnings (non-fatal author guidance)', () => {
    it('warns on a required permission at household/user consent scope (D16)', () => {
      // Household-scope manifest: on a SERVER-scope plugin this combination is
      // now a SCOPE_INCOHERENT error (D-J), and warnings only surface on success.
      const input = manifest({ scope: 'household' });
      input.permissions.declares = [...input.permissions.declares, 'plugin:demo-sink:calendar:write'];
      input.permissions.checks = [
        ...input.permissions.checks,
        {
          slug: 'plugin:demo-sink:calendar:write',
          required: true,
          reason: 'Writes digest reminders to the household calendar.',
          consentScope: 'household',
        },
      ];

      const result = validatePluginManifest(input, options);

      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: ManifestWarningCode.REQUIRED_UNIT_SCOPE_PERMISSION,
          path: 'permissions.checks[2]',
        }),
      ]);
    });
  });

  describe('scope coherence (D-J)', () => {
    it.each(['household', 'user'] as const)(
      "rejects a server-scope plugin requesting '%s'-consentable permission — no per-unit enable surface exists to collect that consent",
      (consentScope) => {
        const input = manifest();
        input.permissions.checks = [
          {
            slug: 'feedback:read',
            required: false,
            reason: 'Reads submitted feedback to compose the weekly digest.',
            consentScope,
          },
        ];

        const error = expectRejection(input, ManifestErrorCode.SCOPE_INCOHERENT);

        expect(error.issues.some((issue) => issue.path === 'permissions.checks[0].consentScope')).toBe(true);
      },
    );

    it('rejects requiresHouseholdConfig on a server-scope plugin with the offending path', () => {
      const error = expectRejection(
        manifest({ config: { requiresHouseholdConfig: true } }),
        ManifestErrorCode.SCOPE_INCOHERENT,
      );

      expect(error.issues.some((issue) => issue.path === 'config.requiresHouseholdConfig')).toBe(true);
    });

    it('accepts per-unit consent scopes and household config on a household-scope plugin (coherence control)', () => {
      const input = manifest({ scope: 'household', config: { requiresHouseholdConfig: true } });
      input.permissions.checks = [
        ...input.permissions.checks,
        {
          slug: 'read:public_content',
          required: false,
          reason: 'Shows public content excerpts inside per-user digests.',
          consentScope: 'user',
        },
      ];

      const result = validatePluginManifest(input, options);

      expect(result.permissionChecks[2]?.consentScope).toBe('user');
    });

    it('does NOT reject household/user-scoped topics on a server-scope plugin — topic subscription is a per-user opt-in (#196), not a PluginGrant', () => {
      // The baseline fixture is exactly this shape (scope 'server', user topic)
      // and stays valid by design.
      const result = validatePluginManifest(manifest(), options);

      expect(result.manifest.topics[0]?.scope).toBe('user');
    });
  });

  describe('slug reservation (D-K)', () => {
    /** Rebuilds every slug-namespaced field so ONLY the reservation rule is exercised. */
    const manifestWithSlug = (slug: string): PluginManifest =>
      manifest({
        slug,
        permissions: {
          declares: [`plugin:${slug}:digest:manage`],
          checks: [
            {
              slug: `plugin:${slug}:digest:manage`,
              required: true,
              reason: { en: 'Stores and manages the digest configuration it owns.' },
              consentScope: 'server',
            },
          ],
        },
        events: { subscribes: [], emits: [`plugin.${slug}.digest-sent`] },
        jobs: { queues: [`plugin:${slug}:digest`], schedules: [] },
        storage: {
          ownTables: [`plugin_${slug.replace(/-/g, '_')}_digests`],
          readsCore: [],
          writesCore: [],
        },
      });

    it.each(['installed', 'load-failed', 'grant-created', 'config-updated'])(
      "rejects the reserved slug '%s' with the offending path and ONLY the reservation issue",
      (slug) => {
        const error = expectRejection(manifestWithSlug(slug), ManifestErrorCode.SLUG_RESERVED);

        expect(error.issues).toEqual([
          expect.objectContaining({ code: ManifestErrorCode.SLUG_RESERVED, path: 'slug' }),
        ]);
      },
    );

    it("accepts a similar but unreserved slug ('installer')", () => {
      const result = validatePluginManifest(manifestWithSlug('installer'), options);

      expect(result.manifest.slug).toBe('installer');
    });
  });

  describe('collect-all behavior', () => {
    it('aggregates every semantic issue in a single throw', () => {
      const input = manifest({
        version: 'one.two',
        bgeCompat: '>=9.0.0',
        network: { outboundDomains: ['HTTPS://bad'] },
        jobs: { queues: ['wrong'], schedules: [] },
      });

      const error = expectRejection(input, ManifestErrorCode.VERSION_INVALID);

      expect(error.has(ManifestErrorCode.BGE_COMPAT_UNSATISFIED)).toBe(true);
      expect(error.has(ManifestErrorCode.OUTBOUND_DOMAIN_INVALID)).toBe(true);
      expect(error.has(ManifestErrorCode.QUEUE_NAMESPACE)).toBe(true);
      expect(error.issues.length).toBeGreaterThanOrEqual(4);
    });
  });
});
