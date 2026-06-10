import type { Actor, ActorContextSnapshot } from '@bge/actor-context';
import { BGE_ACTOR_HEADER, CORRELATION_ID_HEADER } from '@bge/shared';
import { Metadata } from '@grpc/grpc-js';

jest.mock('@bge/actor-context', () => ({
  getActorSnapshotFromCls: jest.fn(),
}));

import { getActorSnapshotFromCls } from '@bge/actor-context';
import {
  createOutboundActorMetadataInterceptor,
  injectActorContextMetadata,
} from './grpc-outbound-actor-metadata.interceptor';

const getActorSnapshotFromClsMock = getActorSnapshotFromCls as jest.MockedFunction<typeof getActorSnapshotFromCls>;

const decodeActor = (metadata: Metadata): Actor | undefined => {
  const value = metadata.get(BGE_ACTOR_HEADER)[0];
  if (value === undefined) {
    return undefined;
  }
  const decoded = Buffer.from(value as string, 'base64').toString('utf8');
  return JSON.parse(decoded) as Actor;
};

describe('injectActorContextMetadata', () => {
  beforeEach(() => {
    getActorSnapshotFromClsMock.mockReset();
  });

  describe('empty CLS snapshot', () => {
    it('adds no metadata when the snapshot is empty', () => {
      getActorSnapshotFromClsMock.mockReturnValue({});
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(metadata.get(BGE_ACTOR_HEADER)).toEqual([]);
      expect(metadata.get(CORRELATION_ID_HEADER)).toEqual([]);
    });
  });

  describe('actor propagation', () => {
    it('serializes a user actor as base64-encoded JSON', () => {
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      getActorSnapshotFromClsMock.mockReturnValue({ actor });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(decodeActor(metadata)).toEqual(actor);
    });

    it('round-trips an apiKey actor including userId', () => {
      const actor: Actor = { kind: 'apiKey', apiKeyId: 'key-xyz', userId: 'user-abc' };
      getActorSnapshotFromClsMock.mockReturnValue({ actor });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(decodeActor(metadata)).toEqual(actor);
    });

    it('round-trips a system actor with reason', () => {
      const actor: Actor = { kind: 'system', reason: 'coordinator-ping' };
      getActorSnapshotFromClsMock.mockReturnValue({ actor });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(decodeActor(metadata)).toEqual(actor);
    });

    it('round-trips a nested plugin actor preserving the trigger chain', () => {
      const actor: Actor = {
        kind: 'plugin',
        pluginId: 'plugin-outer',
        trigger: {
          kind: 'plugin',
          pluginId: 'plugin-inner',
          trigger: { kind: 'user', userId: 'user-abc' },
        },
      };
      getActorSnapshotFromClsMock.mockReturnValue({ actor });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(decodeActor(metadata)).toEqual(actor);
    });

    it('round-trips an external actor including identifier', () => {
      const actor: Actor = {
        kind: 'external',
        system: 'gateway',
        identifier: 'gateway-bgg-instance-1',
      };
      getActorSnapshotFromClsMock.mockReturnValue({ actor });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(decodeActor(metadata)).toEqual(actor);
    });

    it('writes the value under the BGE_ACTOR_HEADER key only', () => {
      getActorSnapshotFromClsMock.mockReturnValue({
        actor: { kind: 'user', userId: 'user-abc' },
      });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      const allKeys = Object.keys(metadata.getMap());
      expect(allKeys).toEqual([BGE_ACTOR_HEADER]);
    });
  });

  describe('correlation id propagation', () => {
    it('sets x-correlation-id when present', () => {
      getActorSnapshotFromClsMock.mockReturnValue({ correlationId: 'corr-xyz' });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(metadata.get(CORRELATION_ID_HEADER)).toEqual(['corr-xyz']);
    });

    it('omits x-correlation-id when not present', () => {
      getActorSnapshotFromClsMock.mockReturnValue({
        actor: { kind: 'user', userId: 'user-abc' },
      });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(metadata.get(CORRELATION_ID_HEADER)).toEqual([]);
    });
  });

  describe('combined snapshot', () => {
    it('writes both actor and correlation ID when both are present', () => {
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      getActorSnapshotFromClsMock.mockReturnValue({ actor, correlationId: 'corr-xyz' });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(decodeActor(metadata)).toEqual(actor);
      expect(metadata.get(CORRELATION_ID_HEADER)).toEqual(['corr-xyz']);
    });
  });

  describe('does not touch trace context', () => {
    it('does not set traceparent or tracestate (OTel auto-instrumentation handles them)', () => {
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      getActorSnapshotFromClsMock.mockReturnValue({ actor, correlationId: 'corr-xyz' });
      const metadata = new Metadata();

      injectActorContextMetadata(metadata);

      expect(metadata.get('traceparent')).toEqual([]);
      expect(metadata.get('tracestate')).toEqual([]);
    });
  });

  describe('preserves caller-supplied metadata', () => {
    it('leaves pre-existing metadata entries untouched', () => {
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      getActorSnapshotFromClsMock.mockReturnValue({ actor });
      const metadata = new Metadata();
      metadata.set('custom-header', 'custom-value');

      injectActorContextMetadata(metadata);

      expect(metadata.get('custom-header')).toEqual(['custom-value']);
      expect(decodeActor(metadata)).toEqual(actor);
    });
  });
});

describe('createOutboundActorMetadataInterceptor', () => {
  beforeEach(() => {
    getActorSnapshotFromClsMock.mockReset();
    getActorSnapshotFromClsMock.mockReturnValue({});
  });

  it('returns a function suitable for use as a grpc-js Interceptor', () => {
    const interceptor = createOutboundActorMetadataInterceptor();

    expect(typeof interceptor).toBe('function');
  });

  it('preserves snapshot shape when called repeatedly with different actors', () => {
    const actors: Actor[] = [
      { kind: 'user', userId: 'u-1' },
      { kind: 'system', reason: 'r-1' },
      { kind: 'apiKey', apiKeyId: 'k-1', userId: 'u-2' },
    ];

    for (const actor of actors) {
      getActorSnapshotFromClsMock.mockReturnValue({ actor });
      const metadata = new Metadata();
      injectActorContextMetadata(metadata);
      expect(decodeActor(metadata)).toEqual(actor);
    }
  });
});

// Confirms the imported type from `@bge/actor-context` is structurally
// the shape we expect — guards against the snapshot interface drifting
// without this lib being updated.
const _snapshotShape: ActorContextSnapshot = {
  actor: { kind: 'system', reason: 'compile-time-check' },
  correlationId: 'compile-time-check',
};
void _snapshotShape;
