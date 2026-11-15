/**
 * Typed failures for the plugin context surface (#59 Phase B).
 *
 * Unlike the loader errors, these deliberately DO cross into plugin code.
 * `UnknownActorKindError` is thrown from `PluginContext.actor.current()`.
 * Returning `null` instead would be indistinguishable from an
 * unauthenticated context and would let a de-synced or forged CLS actor read
 * as "nobody" — the loud failure is the safer signal for both sides. The
 * outbound-domain errors reject `PluginContext.http.fetch`, and carry a
 * `code` so a plugin can recognise them without importing the host (#1083).
 */

/**
 * The CLS actor carries a `kind` outside the host `Actor` union, so no
 * projection onto `PluginActorView` is defined for it. A closed union means
 * this is unreachable for host-populated scopes; it guards against a forged
 * or version-skewed CLS value, never against a new host variant (the
 * projection's exhaustiveness check catches those at compile time).
 */
export class UnknownActorKindError extends Error {
  override readonly name = 'UnknownActorKindError';

  constructor(public readonly actorKind: unknown) {
    super(`Actor kind '${String(actorKind)}' has no PluginActorView projection`);
  }
}

/**
 * A plugin's request, or a redirect it was sent on, went to a host its
 * manifest's `network.outboundDomains` doesn't declare. The message names the
 * hostname, never the URL: a URL can carry a token in its query (#1083).
 */
export class PluginOutboundDomainNotDeclaredError extends Error {
  override readonly name = 'PluginOutboundDomainNotDeclaredError';
  readonly code = 'PLUGIN_OUTBOUND_DOMAIN_NOT_DECLARED' as const;

  constructor(
    public readonly slug: string,
    public readonly hostname: string,
  ) {
    super(`Plugin '${slug}' may not reach '${hostname}': it is not declared in the manifest's network.outboundDomains`);
  }
}

/**
 * The plugin declares `network.outboundDomains: 'configured'`: the hosts come
 * from its configuration, which the HTTP client can't hold it to yet (#1293).
 * Every request is refused rather than let through unbounded.
 */
export class PluginOutboundDomainsNotSupportedError extends Error {
  override readonly name = 'PluginOutboundDomainsNotSupportedError';
  readonly code = 'PLUGIN_OUTBOUND_DOMAINS_CONFIGURED_UNSUPPORTED' as const;

  constructor(public readonly slug: string) {
    super(`Plugin '${slug}' declares configured outbound domains, which the plugin HTTP client does not support yet`);
  }
}
