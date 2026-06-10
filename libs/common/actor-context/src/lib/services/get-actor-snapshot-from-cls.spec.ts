import type { ClsService } from 'nestjs-cls';
import type { Actor } from '../types';

interface MockClsService {
  isActive: jest.Mock<boolean>;
  get: jest.Mock<unknown, [string]>;
}

const mockCls: MockClsService = {
  isActive: jest.fn(),
  get: jest.fn(),
};

const getClsServiceMock = jest.fn<ClsService, []>(() => mockCls as unknown as ClsService);

jest.mock('nestjs-cls', () => {
  const actual = jest.requireActual<typeof import('nestjs-cls')>('nestjs-cls');
  return {
    ...actual,
    ClsServiceManager: {
      ...actual.ClsServiceManager,
      getClsService: () => getClsServiceMock(),
    },
  };
});

import { ACTOR_CLS_KEY, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY } from './audit-context.service';
import { getActorSnapshotFromCls } from './get-actor-snapshot-from-cls';

describe('getActorSnapshotFromCls', () => {
  beforeEach(() => {
    mockCls.isActive.mockReset();
    mockCls.get.mockReset();
    getClsServiceMock.mockReset();
    getClsServiceMock.mockReturnValue(mockCls as unknown as ClsService);
  });

  describe('when CLS is not active', () => {
    it('returns an empty snapshot', () => {
      mockCls.isActive.mockReturnValue(false);

      expect(getActorSnapshotFromCls()).toEqual({});
    });

    it('does not touch cls.get when CLS is inactive', () => {
      mockCls.isActive.mockReturnValue(false);

      getActorSnapshotFromCls();

      expect(mockCls.get).not.toHaveBeenCalled();
    });
  });

  describe('when CLS is active', () => {
    beforeEach(() => {
      mockCls.isActive.mockReturnValue(true);
    });

    it('returns actor, correlationId, and source when all are populated', () => {
      const actor: Actor = { kind: 'user', userId: 'user-abc' };
      mockCls.get.mockImplementation((key: string): unknown => {
        switch (key) {
          case ACTOR_CLS_KEY:
            return actor;
          case CORRELATION_ID_CLS_KEY:
            return 'corr-xyz';
          case SOURCE_CLS_KEY:
            return 'http';
          default:
            return undefined;
        }
      });

      const snapshot = getActorSnapshotFromCls();

      expect(snapshot).toEqual({
        actor,
        correlationId: 'corr-xyz',
        source: 'http',
      });
    });

    it('returns undefined fields when CLS keys are absent', () => {
      mockCls.get.mockReturnValue(undefined);

      const snapshot = getActorSnapshotFromCls();

      expect(snapshot.actor).toBeUndefined();
      expect(snapshot.correlationId).toBeUndefined();
      expect(snapshot.source).toBeUndefined();
    });

    it('returns actor only when only actor is populated', () => {
      const actor: Actor = { kind: 'system', reason: 'scheduler' };
      mockCls.get.mockImplementation((key: string): unknown => (key === ACTOR_CLS_KEY ? actor : undefined));

      const snapshot = getActorSnapshotFromCls();

      expect(snapshot.actor).toEqual(actor);
      expect(snapshot.correlationId).toBeUndefined();
      expect(snapshot.source).toBeUndefined();
    });

    it('reads each CLS key exactly once', () => {
      mockCls.get.mockReturnValue(undefined);

      getActorSnapshotFromCls();

      const readKeys = mockCls.get.mock.calls.map(([key]) => key);
      expect(readKeys).toEqual(expect.arrayContaining([ACTOR_CLS_KEY, CORRELATION_ID_CLS_KEY, SOURCE_CLS_KEY]));
      expect(readKeys).toHaveLength(3);
    });
  });

  describe('error isolation', () => {
    it('returns an empty snapshot when ClsServiceManager.getClsService throws', () => {
      getClsServiceMock.mockImplementation(() => {
        throw new Error('CLS not initialised');
      });

      expect(getActorSnapshotFromCls()).toEqual({});
    });

    it('returns an empty snapshot when isActive throws', () => {
      mockCls.isActive.mockImplementation(() => {
        throw new Error('boom');
      });

      expect(getActorSnapshotFromCls()).toEqual({});
    });

    it('returns an empty snapshot when cls.get throws mid-read', () => {
      mockCls.isActive.mockReturnValue(true);
      mockCls.get.mockImplementation(() => {
        throw new Error('store missing');
      });

      expect(getActorSnapshotFromCls()).toEqual({});
    });
  });
});
