import { SystemRole } from '@bge/database';
import { paginationQuery } from '@bge/testing';
import { RequestMethod } from '@nestjs/common';
import 'reflect-metadata';
import { firstValueFrom } from 'rxjs';
import { HouseholdMemberController } from './household-member.controller';
import { HouseholdMemberService, type HouseholdMemberWithRelations } from './household-member.service';

const PAGINATION = paginationQuery({ limit: 10 });

const MEMBER = { id: 'member-1', householdId: 'hh-1' } as HouseholdMemberWithRelations;
const PROMOTED = { id: 'member-2', householdId: 'hh-1' } as HouseholdMemberWithRelations;

describe('HouseholdMemberController (delegation)', () => {
  let controller: HouseholdMemberController;
  let service: jest.Mocked<
    Pick<
      HouseholdMemberService,
      'getMembers' | 'getMember' | 'updateMemberRole' | 'transferOwnership' | 'removeMember' | 'leaveHousehold'
    >
  >;

  beforeEach(() => {
    service = {
      getMembers: jest.fn().mockResolvedValue({ rows: [MEMBER], total: 1 }),
      getMember: jest.fn().mockResolvedValue(MEMBER),
      updateMemberRole: jest.fn().mockResolvedValue(MEMBER),
      transferOwnership: jest.fn().mockResolvedValue({ owner: PROMOTED, previousOwner: MEMBER }),
      removeMember: jest.fn().mockResolvedValue(MEMBER),
      leaveHousehold: jest.fn().mockResolvedValue(MEMBER),
    };
    controller = new HouseholdMemberController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('getMembers forwards householdId and pagination, wrapping the result in the envelope', async () => {
    const result = await firstValueFrom(controller.getMembers('hh-1', PAGINATION));

    expect(service.getMembers).toHaveBeenCalledWith('hh-1', PAGINATION);
    expect(result).toEqual({
      members: [MEMBER],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('getMember forwards householdId and memberId, wrapping the result', async () => {
    const result = await firstValueFrom(controller.getMember('hh-1', 'member-1'));

    expect(service.getMember).toHaveBeenCalledWith('hh-1', 'member-1');
    expect(result).toEqual({ member: MEMBER });
  });

  it('updateMemberRole forwards ids and the DTO, wrapping with a success message', async () => {
    const dto = { role: SystemRole.HouseholdAdmin } as const;

    const result = await firstValueFrom(controller.updateMemberRole('hh-1', 'member-1', dto));

    expect(service.updateMemberRole).toHaveBeenCalledWith('hh-1', 'member-1', dto);
    expect(result).toEqual({
      message: expect.objectContaining({
        key: 'success.household.member_role_updated',
        args: { memberId: 'member-1' },
      }),
      member: MEMBER,
    });
  });

  it('transferOwnership forwards ids and returns both affected members', async () => {
    const result = await firstValueFrom(controller.transferOwnership('hh-1', 'member-2'));

    expect(service.transferOwnership).toHaveBeenCalledWith('hh-1', 'member-2');
    expect(result).toEqual({
      message: expect.objectContaining({
        key: 'success.household.ownership_transferred',
        args: { memberId: 'member-2' },
      }),
      owner: PROMOTED,
      previousOwner: MEMBER,
    });
  });

  it('removeMember forwards householdId and memberId, wrapping with a success message', async () => {
    const result = await firstValueFrom(controller.removeMember('hh-1', 'member-1'));

    expect(service.removeMember).toHaveBeenCalledWith('hh-1', 'member-1');
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.household.member_removed', args: { memberId: 'member-1' } }),
      member: MEMBER,
    });
  });

  it('leaveHousehold forwards householdId only, wrapping with a success message', async () => {
    const result = await firstValueFrom(controller.leaveHousehold('hh-1'));

    expect(service.leaveHousehold).toHaveBeenCalledWith('hh-1');
    expect(result).toEqual({
      message: expect.objectContaining({ key: 'success.household.member_left' }),
      member: MEMBER,
    });
  });

  describe('route registration', () => {
    it('declares the literal `me` route before the parametric `:memberId` route', () => {
      // NestJS registers routes in declaration order within a controller, so
      // `DELETE me` must precede `DELETE :memberId` or the param route captures
      // the literal. Prototype property order preserves declaration order.
      const methods = Object.getOwnPropertyNames(HouseholdMemberController.prototype);

      const leaveIndex = methods.indexOf('leaveHousehold');
      const removeIndex = methods.indexOf('removeMember');

      expect(leaveIndex).toBeGreaterThan(-1);
      expect(removeIndex).toBeGreaterThan(-1);
      expect(leaveIndex).toBeLessThan(removeIndex);
    });

    it('binds the expected paths to the delete handlers', () => {
      expect(Reflect.getMetadata('path', HouseholdMemberController.prototype.leaveHousehold)).toBe('me');
      expect(Reflect.getMetadata('path', HouseholdMemberController.prototype.removeMember)).toBe(':memberId');
    });

    it('binds transfer-ownership as a POST under the member path', () => {
      // A literal segment AFTER `:memberId` cannot be captured by the parametric
      // route, so this one carries no ordering constraint — unlike `me`.
      expect(Reflect.getMetadata('path', HouseholdMemberController.prototype.transferOwnership)).toBe(
        ':memberId/transfer-ownership',
      );
      expect(Reflect.getMetadata('method', HouseholdMemberController.prototype.transferOwnership)).toBe(
        RequestMethod.POST,
      );
    });
  });
});
