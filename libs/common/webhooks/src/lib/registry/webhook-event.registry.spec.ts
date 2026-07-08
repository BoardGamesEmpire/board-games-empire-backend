import { Action, ResourceType } from '@bge/database';
import { WebhookEventType } from './../constants/webhook-event-types';
import { WebhookEventRegistry } from './webhook-event.registry';

describe('WebhookEventRegistry', () => {
  let registry: WebhookEventRegistry;

  beforeEach(() => {
    registry = new WebhookEventRegistry();
  });

  describe('has', () => {
    it('recognizes a registered event type', () => {
      expect(registry.has(WebhookEventType.EventCreated)).toBe(true);
    });

    it('rejects an unregistered name', () => {
      expect(registry.has('event.event.created')).toBe(false); // unversioned
      expect(registry.has('game.game.updated.v1')).toBe(false); // not yet wired
      expect(registry.has('nonsense')).toBe(false);
    });
  });

  describe('get / require', () => {
    it('returns the descriptor with subject and required action', () => {
      expect(registry.get(WebhookEventType.EventUpdated)).toEqual({
        type: WebhookEventType.EventUpdated,
        subject: ResourceType.Event,
        requiredAction: Action.read,
      });
    });

    it('defaults every v1 descriptor to the read action (visibility is the gate)', () => {
      for (const type of registry.types()) {
        expect(registry.require(type).requiredAction).toBe(Action.read);
      }
    });

    it('require throws for an unknown type (fail loudly)', () => {
      expect(() => registry.require('event.event.created.v9' as WebhookEventType)).toThrow(
        /no webhook event descriptor/i,
      );
    });
  });

  describe('subjectsFor', () => {
    it('collapses duplicate subjects across requested types', () => {
      const subjects = registry.subjectsFor([
        WebhookEventType.EventCreated,
        WebhookEventType.EventUpdated,
        WebhookEventType.EventDeleted,
      ]);

      expect(subjects).toEqual([ResourceType.Event]);
    });

    it('spans subjects for the import lifecycle (Game for imported, Job for the rest)', () => {
      const subjects = registry.subjectsFor([
        WebhookEventType.GameImported,
        WebhookEventType.ImportJobStarted,
        WebhookEventType.ImportJobFailed,
        WebhookEventType.ImportBatchCompleted,
      ]);

      expect(subjects.sort()).toEqual([ResourceType.Game, ResourceType.Job].sort());
    });

    it('throws when any requested type is unregistered', () => {
      expect(() => registry.subjectsFor(['bogus.v1' as WebhookEventType])).toThrow();
    });
  });

  it('exposes exactly the v1 Event-domain and import-lifecycle types', () => {
    expect(registry.types().sort()).toEqual(
      [
        WebhookEventType.EventCreated,
        WebhookEventType.EventDeleted,
        WebhookEventType.EventUpdated,
        WebhookEventType.GameImported,
        WebhookEventType.ImportJobStarted,
        WebhookEventType.ImportJobFailed,
        WebhookEventType.ImportBatchCompleted,
      ].sort(),
    );
  });
});
