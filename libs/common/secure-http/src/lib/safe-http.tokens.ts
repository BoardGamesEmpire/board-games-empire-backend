/**
 * Injection token for the outbound HTTP observer. Bound to
 * `NoopOutboundHttpObserver` by default; consumer modules override with a
 * custom implementation to receive request/response/SSRF events.
 *
 * Single-implementor by design. For fan-out (metrics + audit + OTel),
 * compose a single delegating observer rather than registering multiple —
 * keeps DI semantics unambiguous and lets the service treat the hook
 * surface as a single dependency.
 */
export const OUTBOUND_HTTP_OBSERVER = Symbol('OUTBOUND_HTTP_OBSERVER');

/**
 * Injection token for the DNS resolver. Bound to `DefaultDnsResolver` by
 * default (which wraps `dns.promises.lookup`); tests bind a deterministic
 * fake so they never depend on real DNS or `/etc/hosts`.
 */
export const DNS_RESOLVER = Symbol('DNS_RESOLVER');
