import { Action, ResourceType } from '@bge/database';
import type { AppAbility } from '@bge/permissions';
import { CHECK_POLICIES_KEY, PoliciesGuard } from '@bge/permissions';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { HouseholdLivenessGuard } from '../guards/household-liveness.guard';
import { CollectionSharingController } from './collection-sharing.controller';
import type { CollectionSharingService, ExcludedGameView } from './collection-sharing.service';
import type { HouseholdMemberWithRelations } from './household-member.service';

const MEMBER = { id: 'member-1', householdId: 'hh-1', collectionSharing: false } as HouseholdMemberWithRelations;
const EXCLUDED = { collectionEntryId: 'entry-1', reason: null } as ExcludedGameView;

type Route = keyof Pick<
  CollectionSharingController,
  'setCollectionSharing' | 'listExcludedGames' | 'excludeGame' | 'removeExcludedGame'
>;

describe('CollectionSharingController', () => {
  let controller: CollectionSharingController;
  let service: jest.Mocked<
    Pick<CollectionSharingService, 'setCollectionSharing' | 'listExcludedGames' | 'excludeGame' | 'removeExcludedGame'>
  >;

  beforeEach(() => {
    service = {
      setCollectionSharing: jest.fn().mockResolvedValue(MEMBER),
      listExcludedGames: jest.fn().mockResolvedValue([EXCLUDED]),
      excludeGame: jest.fn().mockResolvedValue(EXCLUDED),
      removeExcludedGame: jest.fn().mockResolvedValue(undefined),
    };
    controller = new CollectionSharingController(service as never);
  });

  describe('each route answers in its envelope with its message (#170)', () => {
    it('setCollectionSharing forwards the household and the DTO, wrapping the member with a success message (#170)', async () => {
      const result = await firstValueFrom(controller.setCollectionSharing('hh-1', { collectionSharing: false }));

      expect(service.setCollectionSharing).toHaveBeenCalledWith('hh-1', { collectionSharing: false });
      expect(result).toEqual({
        message: expect.objectContaining({ key: 'success.household.collection_sharing_updated' }),
        member: MEMBER,
      });
    });

    it('listExcludedGames wraps the caller’s excluded games (#170)', async () => {
      await expect(firstValueFrom(controller.listExcludedGames('hh-1'))).resolves.toEqual({
        excludedGames: [EXCLUDED],
      });
      expect(service.listExcludedGames).toHaveBeenCalledWith('hh-1');
    });

    it('excludeGame forwards the household and the DTO, wrapping the excluded game with a success message (#170)', async () => {
      const dto = { collectionEntryId: 'entry-1', reason: 'Too fragile to lend' };

      const result = await firstValueFrom(controller.excludeGame('hh-1', dto));

      expect(service.excludeGame).toHaveBeenCalledWith('hh-1', dto);
      expect(result).toEqual({
        message: expect.objectContaining({ key: 'success.household.excluded_game_added' }),
        excludedGame: EXCLUDED,
      });
    });

    it('removeExcludedGame forwards the household and the entry, answering with a success message (#170)', async () => {
      const result = await firstValueFrom(controller.removeExcludedGame('hh-1', 'entry-1'));

      expect(service.removeExcludedGame).toHaveBeenCalledWith('hh-1', 'entry-1');
      expect(result).toEqual({ message: expect.objectContaining({ key: 'success.household.excluded_game_removed' }) });
    });
  });

  describe('routing and gates (#170)', () => {
    it('is mounted on the caller’s own membership, with liveness before the policies (#170)', () => {
      expect(Reflect.getMetadata(PATH_METADATA, CollectionSharingController)).toBe(
        'households/:householdId/members/me',
      );
      expect(Reflect.getMetadata('__guards__', CollectionSharingController)).toEqual([
        HouseholdLivenessGuard,
        PoliciesGuard,
      ]);
    });

    it.each<[Route, RequestMethod, string]>([
      ['setCollectionSharing', RequestMethod.PATCH, '/'],
      ['listExcludedGames', RequestMethod.GET, 'excluded-games'],
      ['excludeGame', RequestMethod.POST, 'excluded-games'],
      ['removeExcludedGame', RequestMethod.DELETE, 'excluded-games/:collectionEntryId'],
    ])('%s answers %s at %s (#170)', (route, method, path) => {
      const handler = CollectionSharingController.prototype[route];

      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    });

    // Every household role holds `update:household_member:own` and
    // `read:household_member`, so a guest may say what they share too.
    it.each<[Route, Action]>([
      ['setCollectionSharing', Action.update],
      ['excludeGame', Action.update],
      ['removeExcludedGame', Action.update],
      ['listExcludedGames', Action.read],
    ])('%s asks the guard for %s on HouseholdMember (#170)', (route, action) => {
      const handlers = Reflect.getMetadata(CHECK_POLICIES_KEY, CollectionSharingController.prototype[route]) as Array<
        (ability: AppAbility) => boolean
      >;
      const can = jest.fn().mockReturnValue(true);

      expect(handlers).toHaveLength(1);
      handlers[0]({ can } as unknown as AppAbility);
      expect(can).toHaveBeenCalledTimes(1);
      expect(can).toHaveBeenCalledWith(action, ResourceType.HouseholdMember);
    });
  });
});
