import { webhookEnvelope, WebhookEventType } from '@bge/webhooks';
import { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { HouseholdEvents } from '../constants/household-events.constant';
import { HouseholdEventPublisher, householdWebhook } from './household-event.publisher';
import { HouseholdUpdatedEvent } from './household.events';

const INITIATED_AT = new Date('2026-11-19T12:00:00Z');

describe('HouseholdEventPublisher (#245)', () => {
  let events: { emit: jest.Mock };
  let publisher: HouseholdEventPublisher;
  let logged: jest.SpyInstance;

  const event = () =>
    new HouseholdUpdatedEvent({ id: 'hh-1', name: 'Old name' }, { id: 'hh-1', name: 'New name' }, INITIATED_AT);

  const webhook = () => ({
    type: WebhookEventType.HouseholdUpdated,
    envelope: webhookEnvelope({
      subjectId: 'hh-1',
      householdId: 'hh-1',
      data: { householdId: 'hh-1', changedFields: ['name'] },
    }),
  });

  beforeEach(() => {
    events = { emit: jest.fn().mockReturnValue(true) };
    publisher = new HouseholdEventPublisher(events as unknown as EventEmitter2);
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('emits the domain event, then the webhook envelope', () => {
    const domainEvent = event();
    const { type, envelope } = webhook();

    publisher.publish(domainEvent, { type, envelope });

    expect(events.emit.mock.calls).toEqual([
      [HouseholdEvents.Updated, domainEvent],
      [WebhookEventType.HouseholdUpdated, envelope],
    ]);
    expect(logged).not.toHaveBeenCalled();
  });

  it('logs and swallows a throwing listener, still emitting the webhook (#245)', () => {
    // `EventEmitterModule` runs without `ignoreErrors`, so a listener on the
    // emitter itself (`onAny`, as the audit persistence listener is) throws
    // out of `emit()`. The change has committed by then.
    const failure = new Error('audit listener exploded');
    events.emit.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => publisher.publish(event(), webhook())).not.toThrow();

    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(events.emit.mock.calls[1]?.[0]).toBe(WebhookEventType.HouseholdUpdated);
    expect(logged).toHaveBeenCalledTimes(1);
    // Nest's `(message, stack)` contract: nestjs-pino drops an `Error` passed
    // as a bare argument, so the message and the stack must be strings.
    const [message, stack] = logged.mock.calls[0] as [string, unknown];
    expect(message).toContain(`for ${HouseholdEvents.Updated} (Household hh-1)`);
    expect(message).toContain('audit listener exploded');
    expect(stack).toBe(failure.stack);
  });

  it('logs a non-Error throw by its string form, with no stack argument (#245)', () => {
    events.emit.mockImplementationOnce(() => {
      throw 'boom';
    });

    expect(() => publisher.publish(event())).not.toThrow();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toHaveLength(1);
    expect(logged.mock.calls[0]?.[0]).toContain('boom');
  });

  it('names the webhook type, not the domain event, when the webhook emit throws', () => {
    // The log says what was lost: the domain event went out, the delivery did not.
    events.emit.mockReturnValueOnce(true).mockImplementationOnce(() => {
      throw new Error('dispatcher exploded');
    });

    expect(() => publisher.publish(event(), webhook())).not.toThrow();

    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledTimes(1);
    const [message] = logged.mock.calls[0] as [string];
    expect(message).toContain(`for ${WebhookEventType.HouseholdUpdated} (Household hh-1)`);
  });

  it('emits no webhook when none is given', () => {
    const domainEvent = event();

    publisher.publish(domainEvent);

    expect(events.emit.mock.calls).toEqual([[HouseholdEvents.Updated, domainEvent]]);
  });
});

describe('householdWebhook (#245)', () => {
  it('sends the data it is given under the household id, with no occurrenceId', () => {
    const data = { householdId: 'hh-1', memberId: 'member-1', userId: 'user-1' };

    const { type, envelope } = householdWebhook(WebhookEventType.HouseholdMemberRemoved, data);

    expect(type).toBe(WebhookEventType.HouseholdMemberRemoved);
    expect(envelope).toEqual({ subjectId: 'hh-1', householdId: 'hh-1', data });
    // `data` goes to the subscriber's URL as the caller built it: the same
    // object, so the builder adds, drops and reorders no key.
    expect(envelope.data).toBe(data);
    // No id is stable across re-emits of one change and unique across
    // changes before the audit entry exists, so the delivery is not deduped.
    expect(envelope.occurrenceId).toBeUndefined();
  });
});
