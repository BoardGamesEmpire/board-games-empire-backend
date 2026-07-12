import { AuditContextService } from '@bge/actor-context';
import { FeedbackCategory, FeedbackContext } from '@bge/database';
import type { FeedbackReportSubmittedEvent } from '@bge/feedback';
import { JOB_META_KEY } from '@bge/queue-actor-context';
import type { Queue } from 'bullmq';
import { FEEDBACK_DELIVERY_JOB } from '../constants/feedback-queue.constants';
import type { FeedbackSink } from '../contract/feedback-sink';
import { FeedbackSinkRegistry } from '../sinks/feedback-sink.registry';
import { FeedbackDispatcherService } from './feedback-dispatcher.service';

function sink(slug: string): FeedbackSink {
  return { slug, submit: jest.fn() };
}

function event(overrides: Partial<FeedbackReportSubmittedEvent> = {}): FeedbackReportSubmittedEvent {
  return {
    feedbackReportId: 'report-1',
    submittedById: 'user-1',
    category: FeedbackCategory.Bug,
    context: FeedbackContext.Client,
    severity: null,
    ...overrides,
  };
}

describe('FeedbackDispatcherService', () => {
  let registry: jest.Mocked<Pick<FeedbackSinkRegistry, 'sinksAccepting'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor' | 'getCorrelationId'>>;
  let queue: jest.Mocked<Pick<Queue, 'add'>>;
  let service: FeedbackDispatcherService;

  beforeEach(() => {
    registry = { sinksAccepting: jest.fn() };
    auditContext = {
      getActor: jest.fn().mockReturnValue({ kind: 'user', userId: 'user-1' }),
      getCorrelationId: jest.fn().mockReturnValue('corr-1'),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new FeedbackDispatcherService(
      registry as unknown as FeedbackSinkRegistry,
      auditContext as unknown as AuditContextService,
      queue as unknown as Queue,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('enqueues one delivery job per accepting sink, carrying the actor envelope', async () => {
    registry.sinksAccepting.mockReturnValue([sink('local'), sink('github')]);

    await service.onFeedbackReportSubmitted(event());

    expect(queue.add).toHaveBeenCalledTimes(2);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe(FEEDBACK_DELIVERY_JOB);
    expect(data).toMatchObject({ feedbackReportId: 'report-1', sinkSlug: 'local' });
    expect(data[JOB_META_KEY]).toEqual({ actor: { kind: 'user', userId: 'user-1' }, correlationId: 'corr-1' });
    expect(opts).toMatchObject({ jobId: 'feedback:report-1:local' });
    expect(queue.add.mock.calls[1][2]).toMatchObject({ jobId: 'feedback:report-1:github' });
  });

  it('does not enqueue when no sink accepts the category', async () => {
    registry.sinksAccepting.mockReturnValue([]);

    await service.onFeedbackReportSubmitted(event({ category: FeedbackCategory.FeatureRequest }));

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('isolates a failed enqueue: other sinks still receive their job', async () => {
    registry.sinksAccepting.mockReturnValue([sink('flaky'), sink('local')]);
    queue.add.mockRejectedValueOnce(new Error('redis blip')).mockResolvedValueOnce(undefined as never);

    await expect(service.onFeedbackReportSubmitted(event())).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[1][2]).toMatchObject({ jobId: 'feedback:report-1:local' });
  });

  it('falls back to a system actor when the request has no CLS actor', async () => {
    auditContext.getActor.mockReturnValue(null);
    auditContext.getCorrelationId.mockReturnValue(null);
    registry.sinksAccepting.mockReturnValue([sink('local')]);

    await service.onFeedbackReportSubmitted(event());

    const meta = queue.add.mock.calls[0][1][JOB_META_KEY];
    expect(meta.actor).toEqual({ kind: 'system', reason: 'feedback:unattributed-submission' });
    expect(typeof meta.correlationId).toBe('string');
    expect(meta.correlationId.length).toBeGreaterThan(0);
  });
});
