import { Injectable } from '@nestjs/common';
import type { OutboundHttpObserver } from './interfaces/outbound-http-observer.interface';

/**
 * Default observer bound to `OUTBOUND_HTTP_OBSERVER` when no consumer
 * provides one. All `OutboundHttpObserver` methods are optional, so this
 * empty implementation satisfies the contract and the service's
 * optional-chained calls are no-ops.
 *
 * The service is responsible for guarding observer invocations with `?.`
 * regardless — this class exists so DI resolution always succeeds even
 * when no telemetry is wired up.
 */
@Injectable()
export class NoopOutboundHttpObserver implements OutboundHttpObserver {}
