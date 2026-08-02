import { firstValueFrom } from 'rxjs';
import { HouseholdMemberController } from './household-member.controller';
import { HouseholdMemberService, type HouseholdMemberWithRelations } from './household-member.service';

const PAGINATION = { offset: 0, limit: 10 } as never;

const MEMBER = { id: 'member-1', householdId: 'hh-1' } as HouseholdMemberWithRelations;

describe('HouseholdMemberController (delegation)', () => {
  let controller: HouseholdMemberController;
  let service: jest.Mocked<Pick<HouseholdMemberService, 'getMembers' | 'getMember'>>;

  beforeEach(() => {
    service = {
      getMembers: jest.fn().mockResolvedValue([MEMBER]),
      getMember: jest.fn().mockResolvedValue(MEMBER),
    };
    controller = new HouseholdMemberController(service as never);
  });

  afterEach(() => jest.clearAllMocks());

  it('getMembers forwards householdId and pagination, wrapping the result', async () => {
    const result = await firstValueFrom(controller.getMembers('hh-1', PAGINATION));

    expect(service.getMembers).toHaveBeenCalledWith('hh-1', PAGINATION);
    expect(result).toEqual({ members: [MEMBER] });
  });

  it('getMember forwards householdId and memberId, wrapping the result', async () => {
    const result = await firstValueFrom(controller.getMember('hh-1', 'member-1'));

    expect(service.getMember).toHaveBeenCalledWith('hh-1', 'member-1');
    expect(result).toEqual({ member: MEMBER });
  });
});
