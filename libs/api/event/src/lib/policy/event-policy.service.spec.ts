import {
  Action,
  GameAdditionMode,
  OccurrenceOverrideScope,
  PlatformType,
  Prisma,
  ResourceType,
  VoteThresholdType,
  type EventPolicy,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createMockDatabaseService,
  createTestingModuleWithDb,
  makeEvent,
  makeEventOccurrencePolicy,
  makeEventPolicy,
  rawQueryText,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { UpdateEventPolicyDto } from './dto/update-event-policy.dto';
import { EventPolicyService } from './event-policy.service';
import { EventPolicyUpdatedEvent } from './events/event-policy.events';
import { EVENT_POLICY_VIEW_INCLUDE, OCCURRENCE_POLICY_VIEW_INCLUDE, type OccurrencePolicyView } from './policy-view';

/** A ceiling of its own for each type and action, so a test can tell which one a query was given. */
const ceiling = (resourceType: string, action: string) => [{ ceiling: `${action}:${resourceType}` }];

/** Whether a policy read carries the update ceiling: the read under the lock, as opposed to the read back. */
const underUpdateCeiling = (args: { where: { AND?: unknown } }) =>
  JSON.stringify(args.where.AND) === JSON.stringify(ceiling(ResourceType.EventPolicy, Action.update));

/** The lists stored on the policy, as the ids and types they hold. */
interface StoredLists {
  types: PlatformType[];
  platformIds: string[];
  categoryIds: string[];
}

/** A policy row as a read with the view's embed returns it: the lists as join rows. */
const withJoinRows = (policy: EventPolicy, lists: StoredLists) => ({
  ...policy,
  allowedPlatformTypes: lists.types.map((platformType) => ({ platformType })),
  allowedPlatforms: lists.platformIds.map((platformId) => ({ platformId })),
  allowedCategories: lists.categoryIds.map((categoryId) => ({ categoryId })),
});

/** The policy as it is served, with the lists as plain lists. */
const asView = (policy: EventPolicy, lists: StoredLists = { types: [], platformIds: [], categoryIds: [] }) => ({
  ...policy,
  allowedPlatformTypes: lists.types,
  allowedPlatformIds: lists.platformIds,
  allowedCategoryIds: lists.categoryIds,
});

/** A date's own policy, which overrides only what it is given. */
const datePolicy = (occurrenceId: string, overrides: Partial<OccurrencePolicyView> = {}): OccurrencePolicyView => ({
  ...makeEventOccurrencePolicy(occurrenceId),
  allowedPlatformTypes: [],
  allowedPlatformIds: [],
  allowedCategoryIds: [],
  ...overrides,
});

/** A date's policy row as a read with the view's embed returns it: the lists as join rows. */
const withDateJoinRows = ({
  allowedPlatformTypes,
  allowedPlatformIds,
  allowedCategoryIds,
  ...row
}: OccurrencePolicyView) => ({
  ...row,
  allowedPlatformTypes: allowedPlatformTypes.map((platformType) => ({ platformType })),
  allowedPlatforms: allowedPlatformIds.map((platformId) => ({ platformId })),
  allowedCategories: allowedCategoryIds.map((categoryId) => ({ categoryId })),
});

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
    code: 'P2025',
    clientVersion: 'test',
  });

describe('EventPolicyService', () => {
  let service: EventPolicyService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;
  let emitter: { emit: jest.Mock };

  /** The transaction's client, apart from `db`, so a write outside the transaction can't pass for one inside it. */
  let tx: MockDatabaseService;

  /** The policy row the read under the lock finds. */
  let stored: EventPolicy | null;

  /** The policy row the read under the read ceiling finds after the write. */
  let readable: EventPolicy | null;

  /** The lists stored on the policy. */
  let lists: StoredLists;

  /** Each date's own policy, as it is served. */
  let datePolicies: OccurrencePolicyView[];

  const update = (dto: UpdateEventPolicyDto) => service.updatePolicy('event-1', dto);

  beforeEach(async () => {
    // The service logs every refusal it passes on; the tests assert the refusal.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockImplementation(ceiling);
    emitter = { emit: jest.fn() };

    const ctx = await createTestingModuleWithDb({
      providers: [
        EventPolicyService,
        { provide: EventEmitter2, useValue: emitter },
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(EventPolicyService);

    tx = createMockDatabaseService();
    db.$transaction.mockImplementation((async (callback: (client: MockDatabaseService) => Promise<unknown>) => {
      const result = await callback(tx);

      // Nothing is told of a change before it commits.
      expect(emitter.emit).not.toHaveBeenCalled();

      return result;
    }) as never);

    stored = makeEventPolicy('event-1', { id: 'policy-1' });
    readable = null;
    datePolicies = [];
    lists = { types: [], platformIds: [], categoryIds: [] };

    tx.$queryRaw.mockResolvedValue([]);
    tx.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1' }));

    // The read under the lock carries the update ceiling; the read back carries the read ceiling.
    tx.eventPolicy.findUnique.mockImplementation(((args: { where: { AND?: unknown } }) =>
      Promise.resolve(
        underUpdateCeiling(args) ? stored && withJoinRows(stored, lists) : readable && withJoinRows(readable, lists),
      )) as never);
    tx.eventOccurrencePolicy.findMany.mockImplementation((() =>
      Promise.resolve(datePolicies.map(withDateJoinRows))) as never);
    tx.eventPolicy.update.mockImplementation(((args: { data: Partial<EventPolicy> }) =>
      Promise.resolve({ ...(stored as EventPolicy), ...args.data })) as never);
  });

  afterEach(() => jest.restoreAllMocks());

  // The lock is the one a date write and an event write take, so the policy
  // and the dates' overrides it is checked against can't change before the
  // write lands, and a deleted event answers 404. The policy is read next,
  // under the grant's ceiling, before anything that could refuse with a 400
  // is read. The lists are rewritten before the read back, so the answer
  // serves them as written (#796, #1268).
  it('locks the event, reads the policy under the update ceiling before the date policies, and writes before reading back (#796)', async () => {
    const order: string[] = [];
    const record =
      <T>(label: string, answer: () => T) =>
      () => {
        order.push(label);
        return Promise.resolve(answer());
      };

    tx.$queryRaw.mockImplementation(record('lock', () => []) as never);
    tx.eventPolicy.findUnique.mockImplementation(((args: { where: { AND?: unknown } }) =>
      underUpdateCeiling(args)
        ? record('read policy', () => stored && withJoinRows(stored, lists))()
        : record('read back', () => readable && withJoinRows(readable, lists))()) as never);
    tx.eventOccurrencePolicy.findMany.mockImplementation(
      record('read date policies', () => datePolicies.map(withDateJoinRows)) as never,
    );
    tx.platform.count.mockImplementation(record('check references', () => 1) as never);
    tx.eventPolicy.update.mockImplementation(record('update', () => stored) as never);
    tx.eventPolicyPlatform.deleteMany.mockImplementation(record('delete list', () => ({ count: 0 })) as never);
    tx.eventPolicyPlatform.createMany.mockImplementation(record('create list', () => ({ count: 1 })) as never);

    await update({ gameAdditionMode: GameAdditionMode.RequiresVote, allowedPlatformIds: ['plat-1'] });

    expect(rawQueryText(tx.$queryRaw.mock.calls[0][0])).toMatch(
      /^SELECT id FROM events WHERE id = \? FOR NO KEY UPDATE$/,
    );
    expect(order).toEqual([
      'lock',
      'read policy',
      'read date policies',
      'check references',
      'update',
      'delete list',
      'create list',
      'read back',
    ]);
    expect(tx.eventPolicy.findUnique).toHaveBeenNthCalledWith(1, {
      where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.update) },
      include: EVENT_POLICY_VIEW_INCLUDE,
    });
    expect(tx.eventOccurrencePolicy.findMany).toHaveBeenCalledWith({
      where: { occurrence: { eventId: 'event-1' } },
      include: OCCURRENCE_POLICY_VIEW_INCLUDE,
    });
  });

  // The patch is judged merged over what is stored: a value already stored
  // satisfies a type that needs one, and a value neither holds doesn't (#796).
  describe('the voting policy the patch leaves', () => {
    it('refuses a threshold type that needs a value the patch and the stored policy both lack (#796)', async () => {
      await expect(update({ voteThresholdType: VoteThresholdType.Supermajority })).rejects.toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.threshold_value_required') },
      });

      expect(tx.eventPolicy.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('accepts a threshold type whose value is already stored (#796)', async () => {
      stored = makeEventPolicy('event-1', { id: 'policy-1', voteThresholdValue: 66 });

      await update({ voteThresholdType: VoteThresholdType.Supermajority });

      expect(tx.eventPolicy.update).toHaveBeenCalled();
    });

    // The date sets Supermajority and relies on the event's value, so
    // clearing the event's value leaves the date's policy with none.
    it("refuses a patch that leaves a date's effective vote threshold without a value (#796)", async () => {
      stored = makeEventPolicy('event-1', { id: 'policy-1', voteThresholdValue: 66 });
      datePolicies = [datePolicy('occ-1', { voteThresholdType: VoteThresholdType.Supermajority })];

      await expect(update({ voteThresholdValue: null })).rejects.toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.threshold_value_required') },
      });

      expect(tx.eventPolicy.update).not.toHaveBeenCalled();
    });

    // 150 is a fine count for the event's FixedCount, but the date reads it as
    // its Supermajority percentage, which no vote can reach.
    it("refuses an event value that a date's percentage threshold would read as above 100 (#796)", async () => {
      datePolicies = [datePolicy('occ-1', { voteThresholdType: VoteThresholdType.Supermajority })];

      await expect(
        update({ voteThresholdType: VoteThresholdType.FixedCount, voteThresholdValue: 150 }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.threshold_percent_too_high') },
      });

      expect(tx.eventPolicy.update).not.toHaveBeenCalled();
    });
  });

  // A patch is judged against every date's own restrictions, under the lock,
  // as it leaves the event's: its override scope and its restrictions. The
  // host changes the dates in the way first, rather than losing what they set
  // (#796).
  describe("the dates' restrictions against the override scope the patch leaves", () => {
    beforeEach(() => {
      // Every platform id sent matches a row.
      const countIds = (args: { where: { id: { in: string[] } } }) => Promise.resolve(args.where.id.in.length);
      tx.platform.count.mockImplementation(countIds as never);
    });

    /** The refusal naming the dates past the scope: by id for a client, by count in the message. */
    const exceedsScope = (occurrenceIds: string[]) => ({
      status: 400,
      response: {
        code: 'EVENT_POLICY_OCCURRENCES_EXCEED_SCOPE',
        message: t('errors.event_policy.occurrences_exceed_scope', { count: occurrenceIds.length }),
        occurrenceIds,
      },
    });

    it('refuses a tighter scope while an occurrence goes past it, naming the occurrence (#796)', async () => {
      datePolicies = [
        datePolicy('occ-1', { platformTypesUnrestricted: true }),
        datePolicy('occ-2', { gameAdditionMode: GameAdditionMode.HostOnly }),
      ];

      await expect(update({ occurrenceOverrideScope: OccurrenceOverrideScope.TightenOnly })).rejects.toMatchObject(
        exceedsScope(['occ-1']),
      );

      expect(tx.eventPolicy.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it("refuses narrowing the event's platforms below what a TightenOnly occurrence sets (#796)", async () => {
      stored = makeEventPolicy('event-1', {
        id: 'policy-1',
        occurrenceOverrideScope: OccurrenceOverrideScope.TightenOnly,
      });
      lists = { types: [], platformIds: ['plat-1', 'plat-2'], categoryIds: [] };
      datePolicies = [datePolicy('occ-1', { allowedPlatformIds: ['plat-2'] })];

      await expect(update({ allowedPlatformIds: ['plat-1'] })).rejects.toMatchObject(exceedsScope(['occ-1']));

      expect(tx.eventPolicy.update).not.toHaveBeenCalled();
      expect(tx.eventPolicyPlatform.deleteMany).not.toHaveBeenCalled();
    });

    it('allows a tighter scope once the occurrences fit (#796)', async () => {
      lists = { types: [PlatformType.PC, PlatformType.Tabletop], platformIds: [], categoryIds: [] };
      datePolicies = [datePolicy('occ-1', { allowedPlatformTypes: [PlatformType.Tabletop] })];

      await update({ occurrenceOverrideScope: OccurrenceOverrideScope.TightenOnly });

      expect(tx.eventPolicy.update).toHaveBeenCalledWith({
        where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.update) },
        data: { occurrenceOverrideScope: OccurrenceOverrideScope.TightenOnly },
      });
    });
  });

  // The route's guard passes anyone holding update:event_policy on any event.
  // The policy is read under this event's update ceiling before the patch is
  // judged, so a caller it doesn't reach finds no row and gets 403, never a
  // 400 that tells them what this event's policy holds (#796).
  it('answers 403 to a caller outside the update ceiling before judging the patch (#796)', async () => {
    stored = null;

    // Invalid against the stored policy, which holds no threshold value.
    await expect(update({ voteThresholdType: VoteThresholdType.Supermajority })).rejects.toThrow(
      new ForbiddenException(t('common.forbidden.update')),
    );

    expect(tx.eventPolicy.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.eventPolicy.findUnique).toHaveBeenCalledWith({
      where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.update) },
      include: EVENT_POLICY_VIEW_INCLUDE,
    });
    expect(tx.eventOccurrencePolicy.findMany).not.toHaveBeenCalled();
    expect(tx.eventPolicy.update).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  // The route's guard passes on a type-level check; the row's own grant, the
  // event role's or the household's, is checked under the lock and enforced
  // again in the write (#796).
  it('updates under the update:event_policy ceiling and answers 403 when the row is outside it', async () => {
    const dto = { allowSpectators: false };

    await update(dto);

    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.EventPolicy, Action.update);
    expect(tx.eventPolicy.update).toHaveBeenCalledWith({
      where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.update) },
      data: dto,
    });

    emitter.emit.mockClear();
    tx.eventPolicy.update.mockRejectedValue(dependentRecordNotFound());

    await expect(update(dto)).rejects.toThrow(new ForbiddenException(t('common.forbidden.update')));
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  // A writer who may change the policy but not read it, such as an API key
  // granted update:event_policy alone, still writes, and is answered null.
  it('answers with the policy read under the read ceiling, null when the caller cannot read it (#796)', async () => {
    readable = makeEventPolicy('event-1', { id: 'policy-1', allowSpectators: false });

    await expect(update({ allowSpectators: false })).resolves.toEqual(asView(readable));
    expect(tx.eventPolicy.findUnique).toHaveBeenLastCalledWith({
      where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.read) },
      include: EVENT_POLICY_VIEW_INCLUDE,
    });

    emitter.emit.mockClear();
    readable = null;

    await expect(update({ allowSpectators: false })).resolves.toBeNull();
    expect(tx.eventPolicy.update).toHaveBeenCalledTimes(2);
  });

  it('emits one EventPolicyUpdatedEvent carrying only the changed columns (#728)', async () => {
    await update({ gameAdditionMode: GameAdditionMode.RequiresVote, allowSpectators: true });

    const domainEmits = emitter.emit.mock.calls.filter(([name]) => name === EventPolicyUpdatedEvent.eventName);
    expect(domainEmits).toHaveLength(1);
    const [name, emitted] = domainEmits[0];
    expect(name).toBe(EventPolicyUpdatedEvent.eventName);
    expect(emitted).toBeInstanceOf(EventPolicyUpdatedEvent);
    expect(emitted.action).toBe('update');
    expect(emitted.subject).toBe(ResourceType.EventPolicy);
    expect(emitted.subjectId).toBe('policy-1');
    expect(emitted.eventId).toBe('event-1');
    expect(emitted.before).toEqual({ id: 'policy-1', gameAdditionMode: GameAdditionMode.Direct });
    expect(emitted.after).toEqual({ id: 'policy-1', gameAdditionMode: GameAdditionMode.RequiresVote });
  });

  // Names only: `data` is copied verbatim to a URL the subscriber controls (#796).
  it('sends event.policy.updated.v1 with the changed field names and no values (#796)', async () => {
    tx.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1', householdId: 'hh-1' }));

    await update({ gameAdditionMode: GameAdditionMode.RequiresVote, allowSpectators: true });

    expect(emitter.emit).toHaveBeenCalledWith(WebhookEventType.EventPolicyUpdated, {
      subjectId: 'policy-1',
      householdId: 'hh-1',
      data: { eventId: 'event-1', householdId: 'hh-1', policyId: 'policy-1', changedFields: ['gameAdditionMode'] },
    });
    expect(JSON.stringify(emitter.emit.mock.calls.at(-1))).not.toContain(GameAdditionMode.RequiresVote);
  });

  // A form that re-sends what it loaded changes nothing, so it writes no
  // audit row and sends no webhook (#728).
  it('emits nothing, neither the audit event nor the webhook, when the patch changes no value (#728)', async () => {
    await update({ gameAdditionMode: GameAdditionMode.Direct, allowSpectators: true });

    expect(tx.eventPolicy.update).toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  /**
   * #1268. The allowed lists are not columns: a list sent replaces the stored
   * one, an empty one clears it, and one left out stays.
   */
  describe('the allowed lists', () => {
    beforeEach(() => {
      lists = { types: [PlatformType.Tabletop], platformIds: ['plat-1'], categoryIds: ['cat-1', 'cat-2'] };
      // Every id sent matches a row, unless a test says otherwise.
      const countIds = (args: { where: { id: { in: string[] } } }) => Promise.resolve(args.where.id.in.length);
      tx.platform.count.mockImplementation(countIds as never);
      tx.category.count.mockImplementation(countIds as never);
    });

    const webhookFields = () =>
      emitter.emit.mock.calls.find(([name]) => name === WebhookEventType.EventPolicyUpdated)?.[1].data.changedFields;

    it('replaces a list it is sent and keeps one it is not (#1268)', async () => {
      await update({ allowedPlatformIds: ['plat-2'] });

      expect(tx.eventPolicyPlatform.deleteMany).toHaveBeenCalledWith({ where: { eventPolicyId: 'policy-1' } });
      expect(tx.eventPolicyPlatform.createMany).toHaveBeenCalledWith({
        data: [{ eventPolicyId: 'policy-1', platformId: 'plat-2' }],
      });
      expect(tx.eventPolicyPlatformType.deleteMany).not.toHaveBeenCalled();
      expect(tx.eventPolicyCategory.deleteMany).not.toHaveBeenCalled();
    });

    it('clears a list sent empty (#1268)', async () => {
      await update({ allowedCategoryIds: [] });

      expect(tx.eventPolicyCategory.deleteMany).toHaveBeenCalledWith({ where: { eventPolicyId: 'policy-1' } });
      expect(tx.eventPolicyCategory.createMany).toHaveBeenCalledWith({ data: [] });
    });

    it('checks the ids it is sent exist, in the transaction, before writing (#1268)', async () => {
      tx.platform.count.mockResolvedValue(0 as never);

      await expect(update({ allowedPlatformIds: ['nope'] })).rejects.toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_UNKNOWN_REFERENCE', message: t('errors.event_policy.unknown_platform') },
      });

      expect(tx.platform.count).toHaveBeenCalledWith({ where: { id: { in: ['nope'] } } });
      expect(tx.eventPolicy.update).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('serves the lists it holds after the write as ids and types (#1268)', async () => {
      readable = makeEventPolicy('event-1', { id: 'policy-1' });

      await expect(update({ allowedPlatformIds: ['plat-2'] })).resolves.toEqual(asView(readable, lists));
    });

    // The audit row records the list as it is stored and served, deduplicated
    // and sorted, so its before and after compare by value whatever order the
    // request sent (#1268).
    it('emits once for a patch that changes only a list, naming the list as it is stored (#1268)', async () => {
      await update({ allowedPlatformTypes: [PlatformType.Tabletop, PlatformType.PC, PlatformType.Tabletop] });

      const [, emitted] = emitter.emit.mock.calls.find(([name]) => name === EventPolicyUpdatedEvent.eventName) ?? [];
      expect(emitted.before).toEqual({ id: 'policy-1', allowedPlatformTypes: [PlatformType.Tabletop] });
      expect(emitted.after).toEqual({
        id: 'policy-1',
        allowedPlatformTypes: [PlatformType.PC, PlatformType.Tabletop],
      });
      expect(webhookFields()).toEqual(['allowedPlatformTypes']);
      expect(emitter.emit).toHaveBeenCalledTimes(2);
    });

    // The lists aren't columns, so a patch that changes only a list leaves
    // the row's own update with no column to write, and Prisma moves
    // updatedAt only when it writes one (#1268).
    it("moves the policy's updatedAt for a patch that changes only a list, and not for one that changes none (#1268)", async () => {
      await update({ allowedPlatformIds: ['plat-2'] });

      expect(tx.eventPolicy.update).toHaveBeenLastCalledWith({
        where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.update) },
        data: { updatedAt: expect.any(Date) },
      });

      emitter.emit.mockClear();
      await update({ allowedPlatformIds: ['plat-1'] });

      expect(tx.eventPolicy.update).toHaveBeenLastCalledWith({
        where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.update) },
        data: {},
      });
    });

    it('names a changed list beside a changed column (#1268)', async () => {
      await update({ allowSpectators: false, allowedCategoryIds: ['cat-3'] });

      expect(webhookFields()).toEqual(['allowSpectators', 'allowedCategoryIds']);
    });

    // A form that re-sends what it loaded changes nothing, in whatever order
    // its lists come back (#728, #1268).
    it('emits nothing for a list re-sent unchanged, in any order, and rewrites nothing (#1268)', async () => {
      await update({ allowedCategoryIds: ['cat-2', 'cat-1'], allowedPlatformTypes: [PlatformType.Tabletop] });

      expect(emitter.emit).not.toHaveBeenCalled();
      expect(tx.eventPolicyCategory.deleteMany).not.toHaveBeenCalled();
      expect(tx.eventPolicyPlatformType.deleteMany).not.toHaveBeenCalled();
    });
  });

  it('answers 400 for an empty body (#796)', async () => {
    await expect(update({})).rejects.toThrow(new BadRequestException(t('common.at_least_one_field')));
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
