import {
  Action,
  GameAdditionMode,
  Prisma,
  ResourceType,
  VoteThresholdType,
  type EventOccurrencePolicy,
  type EventPolicy,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import {
  createMockAbilityService,
  createMockDatabaseService,
  createTestingModuleWithDb,
  makeEvent,
  makeEventPolicy,
  rawQueryText,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { WebhookEventType } from '@bge/webhooks';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { UpdateEventPolicyDto } from './dto/update-event-policy.dto';
import { EventPolicyService } from './event-policy.service';
import { EventPolicyUpdatedEvent } from './events/event-policy.events';

/** A ceiling of its own for each type and action, so a test can tell which one a query was given. */
const ceiling = (resourceType: string, action: string) => [{ ceiling: `${action}:${resourceType}` }];

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

  /** Each date's own policy row. */
  let datePolicies: EventOccurrencePolicy[];

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

    tx.$queryRaw.mockResolvedValue([]);
    tx.event.findUnique.mockResolvedValue(makeEvent({ id: 'event-1' }));

    // The read under the lock carries no ceiling; the read back carries the read ceiling.
    tx.eventPolicy.findUnique.mockImplementation(((args: { where: { AND?: unknown } }) =>
      Promise.resolve(args.where.AND === undefined ? stored : readable)) as never);
    tx.eventOccurrencePolicy.findMany.mockImplementation((() => Promise.resolve(datePolicies)) as never);
    tx.eventPolicy.update.mockImplementation(((args: { data: Partial<EventPolicy> }) =>
      Promise.resolve({ ...(stored as EventPolicy), ...args.data })) as never);
  });

  afterEach(() => jest.restoreAllMocks());

  // The lock is the one a date write and an event write take, so the policy
  // and the dates' overrides it is checked against can't change before the
  // write lands, and a deleted event answers 404 (#796).
  it('locks the event before reading the policy (#796)', async () => {
    const order: string[] = [];
    const record =
      <T>(label: string, answer: () => T) =>
      () => {
        order.push(label);
        return Promise.resolve(answer());
      };

    tx.$queryRaw.mockImplementation(record('lock', () => []) as never);
    tx.eventPolicy.findUnique.mockImplementation(((args: { where: { AND?: unknown } }) =>
      args.where.AND === undefined
        ? record('read policy', () => stored)()
        : record('read back', () => readable)()) as never);
    tx.eventOccurrencePolicy.findMany.mockImplementation(record('read date policies', () => datePolicies) as never);
    tx.eventPolicy.update.mockImplementation(record('update', () => stored) as never);

    await update({ gameAdditionMode: GameAdditionMode.RequiresVote });

    expect(rawQueryText(tx.$queryRaw.mock.calls[0][0])).toMatch(
      /^SELECT id FROM events WHERE id = \? FOR NO KEY UPDATE$/,
    );
    expect(order).toEqual(['lock', 'read policy', 'read date policies', 'update', 'read back']);
    expect(tx.eventPolicy.findUnique).toHaveBeenNthCalledWith(1, { where: { eventId: 'event-1' } });
    expect(tx.eventOccurrencePolicy.findMany).toHaveBeenCalledWith({ where: { occurrence: { eventId: 'event-1' } } });
  });

  // The patch is judged merged over what is stored: a value already stored
  // satisfies a type that needs one, and a value neither holds doesn't (#796).
  describe('the voting rules the patch leaves', () => {
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
    // clearing the event's value leaves the date's rule with none.
    it("refuses a patch that leaves a date's effective vote threshold without a value (#796)", async () => {
      stored = makeEventPolicy('event-1', { id: 'policy-1', voteThresholdValue: 66 });
      datePolicies = [
        {
          occurrenceId: 'occ-1',
          voteThresholdType: VoteThresholdType.Supermajority,
          voteThresholdValue: null,
        } as EventOccurrencePolicy,
      ];

      await expect(update({ voteThresholdValue: null })).rejects.toMatchObject({
        status: 400,
        response: { code: 'EVENT_POLICY_INVALID', message: t('errors.event_policy.threshold_value_required') },
      });

      expect(tx.eventPolicy.update).not.toHaveBeenCalled();
    });
  });

  // Every event is created with its policy row, which goes only with the
  // event, so a missing row answers as a missing event does.
  it('answers 404 when the event has no policy row, and writes nothing', async () => {
    stored = null;

    await expect(update({ allowSpectators: false })).rejects.toThrow(
      new NotFoundException(t('errors.event.not_found', { id: 'event-1' })),
    );
    expect(tx.eventPolicy.update).not.toHaveBeenCalled();
  });

  // The route's guard passes on a type-level check; the row's own grant, the
  // event role's or the household's, is enforced in the write (#796).
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
  it('answers with the policy read under the read ceiling, null when the caller cannot read it', async () => {
    readable = makeEventPolicy('event-1', { id: 'policy-1', allowSpectators: false });

    await expect(update({ allowSpectators: false })).resolves.toEqual(readable);
    expect(tx.eventPolicy.findUnique).toHaveBeenLastCalledWith({
      where: { eventId: 'event-1', AND: ceiling(ResourceType.EventPolicy, Action.read) },
    });

    emitter.emit.mockClear();
    readable = null;

    await expect(update({ allowSpectators: false })).resolves.toBeNull();
    expect(tx.eventPolicy.update).toHaveBeenCalledTimes(2);
  });

  it('emits one EventPolicyUpdatedEvent carrying only the changed columns', async () => {
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

  it('sends no webhook when nothing changed', async () => {
    await update({ gameAdditionMode: GameAdditionMode.Direct, allowSpectators: true });

    expect(emitter.emit).not.toHaveBeenCalledWith(WebhookEventType.EventPolicyUpdated, expect.anything());
  });

  // A form that re-sends what it loaded changes nothing, so it writes no
  // audit row (#728).
  it('emits nothing when the patch changes no value', async () => {
    await update({ gameAdditionMode: GameAdditionMode.Direct, allowSpectators: true });

    expect(tx.eventPolicy.update).toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('answers 400 for an empty body', async () => {
    await expect(update({})).rejects.toThrow(new BadRequestException(t('common.at_least_one_field')));
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
