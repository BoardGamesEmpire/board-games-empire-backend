import { FeedbackCategory } from '@bge/database';
import { FeedbackSinkMisconfiguredError, SinkNotRegisteredError } from '../contract/errors';
import type { FeedbackSink } from '../contract/feedback-sink';
import { FeedbackSinkRegistry } from './feedback-sink.registry';

function sink(slug: string, acceptsCategory?: FeedbackSink['acceptsCategory']): FeedbackSink {
  return { slug, submit: jest.fn(), ...(acceptsCategory ? { acceptsCategory } : {}) };
}

describe('FeedbackSinkRegistry', () => {
  describe('construction invariants', () => {
    it('throws when no sinks are registered', () => {
      expect(() => new FeedbackSinkRegistry([])).toThrow(FeedbackSinkMisconfiguredError);
    });

    it('throws on a duplicate slug', () => {
      expect(() => new FeedbackSinkRegistry([sink('local'), sink('local')])).toThrow(FeedbackSinkMisconfiguredError);
    });
  });

  describe('resolve', () => {
    it('returns the sink registered for a slug', () => {
      const local = sink('local');
      const registry = new FeedbackSinkRegistry([local]);
      expect(registry.resolve('local')).toBe(local);
    });

    it('throws SinkNotRegisteredError for an unknown slug', () => {
      const registry = new FeedbackSinkRegistry([sink('local')]);
      expect(() => registry.resolve('github')).toThrow(SinkNotRegisteredError);
    });
  });

  describe('sinksAccepting', () => {
    it('includes a sink with no acceptsCategory for every category', () => {
      const local = sink('local');
      const registry = new FeedbackSinkRegistry([local]);
      expect(registry.sinksAccepting(FeedbackCategory.Bug)).toEqual([local]);
      expect(registry.sinksAccepting(FeedbackCategory.FeatureRequest)).toEqual([local]);
    });

    it('honours a sink category filter', () => {
      const local = sink('local');
      const bugsOnly = sink('github', (c) => c === FeedbackCategory.Bug);
      const registry = new FeedbackSinkRegistry([local, bugsOnly]);

      expect(registry.sinksAccepting(FeedbackCategory.Bug)).toEqual([local, bugsOnly]);
      expect(registry.sinksAccepting(FeedbackCategory.FeatureRequest)).toEqual([local]);
    });
  });

  it('exposes registered slugs', () => {
    const registry = new FeedbackSinkRegistry([sink('local'), sink('github', () => true)]);
    expect(registry.slugs).toEqual(['local', 'github']);
  });
});
