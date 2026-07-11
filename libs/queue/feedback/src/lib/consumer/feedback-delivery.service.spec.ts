import type { FeedbackReport, FeedbackSubmission } from '@bge/database';
import { FeedbackSubmissionStatus } from '@bge/database';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { SinkNotRegisteredError } from '../contract/errors';
import type { FeedbackSink } from '../contract/feedback-sink';
import type { FeedbackDeliveryJob } from '../interfaces/feedback-delivery-job.interface';
import { FeedbackSinkRegistry } from '../sinks/feedback-sink.registry';
import { FeedbackDeliveryService } from './feedback-delivery.service';

const JOB: FeedbackDeliveryJob = { feedbackReportId: 'report-1', sinkSlug: 'local' };

describe('FeedbackDeliveryService', () => {
  let service: FeedbackDeliveryService;
  let db: MockDatabaseService;
  let sink: jest.Mocked<Pick<FeedbackSink, 'submit'>> & { slug: string };
  let registry: jest.Mocked<Pick<FeedbackSinkRegistry, 'resolve'>>;

  beforeEach(async () => {
    sink = { slug: 'local', submit: jest.fn() };
    registry = { resolve: jest.fn().mockReturnValue(sink) };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [FeedbackDeliveryService, { provide: FeedbackSinkRegistry, useValue: registry }],
    });

    service = module.get(FeedbackDeliveryService);
    db = mockDb;

    db.feedbackReport.findUnique.mockResolvedValue({ id: 'report-1' } as FeedbackReport);
    db.feedbackSubmission.upsert.mockResolvedValue({ id: 'sub-1' } as FeedbackSubmission);
    db.feedbackSubmission.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => jest.clearAllMocks());

  describe('deliver', () => {
    it('submits to the sink and marks the submission Submitted on success', async () => {
      sink.submit.mockResolvedValue({ externalId: 'report-1', externalUrl: null });

      await service.deliver(JOB);

      expect(sink.submit).toHaveBeenCalledWith({ id: 'report-1' }, { submissionId: 'sub-1' });
      expect(db.feedbackSubmission.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub-1' },
          data: expect.objectContaining({ status: FeedbackSubmissionStatus.Submitted, externalId: 'report-1' }),
        }),
      );
    });

    it('upserts the submission on the (report, sink) unique key (no duplicate row on retry)', async () => {
      sink.submit.mockResolvedValue({ externalId: 'report-1' });

      await service.deliver(JOB);

      expect(db.feedbackSubmission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { feedbackReportId_sinkSlug: { feedbackReportId: 'report-1', sinkSlug: 'local' } },
          update: {},
        }),
      );
    });

    it('skips silently when the report was purged before delivery', async () => {
      db.feedbackReport.findUnique.mockResolvedValue(null);

      await service.deliver(JOB);

      expect(sink.submit).not.toHaveBeenCalled();
      expect(db.feedbackSubmission.upsert).not.toHaveBeenCalled();
    });

    it('records the failed attempt and rethrows so BullMQ retries', async () => {
      const boom = new Error('gave up');
      sink.submit.mockRejectedValue(boom);

      await expect(service.deliver(JOB)).rejects.toThrow(boom);

      expect(db.feedbackSubmission.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub-1' },
          data: expect.objectContaining({ attempts: { increment: 1 } }),
        }),
      );
    });

    it('does not persist raw sink error text to lastError (only the class name)', async () => {
      sink.submit.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:443 token=secret'));

      await expect(service.deliver(JOB)).rejects.toThrow();

      const data = db.feedbackSubmission.updateMany.mock.calls[0][0].data;
      expect(data.lastError).toBe('Error');
    });

    it('records a Failed audit row when the slug is unrouteable (registry drift)', async () => {
      registry.resolve.mockImplementation(() => {
        throw new SinkNotRegisteredError('github');
      });

      await expect(service.deliver({ feedbackReportId: 'report-1', sinkSlug: 'github' })).rejects.toThrow(
        SinkNotRegisteredError,
      );

      // The row is created before resolve(), so a misrouted job leaves a trace.
      expect(db.feedbackSubmission.upsert).toHaveBeenCalled();
      const data = db.feedbackSubmission.updateMany.mock.calls[0][0].data;
      expect(data.lastError).toContain('SINK_NOT_REGISTERED');
    });

    it('does not mislabel a post-submit bookkeeping failure as an attempt failure', async () => {
      sink.submit.mockResolvedValue({ externalId: 'report-1' });
      // The success-bookkeeping write fails transiently.
      db.feedbackSubmission.updateMany.mockRejectedValueOnce(new Error('db blip'));

      await expect(service.deliver(JOB)).rejects.toThrow('db blip');

      // Exactly one updateMany (the Submitted write). The attempt-failure path
      // must NOT run — the submit itself succeeded.
      expect(db.feedbackSubmission.updateMany).toHaveBeenCalledTimes(1);
      expect(db.feedbackSubmission.updateMany.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ status: FeedbackSubmissionStatus.Submitted }),
      );
    });
  });

  describe('recordTerminalFailure', () => {
    it('flips a Pending submission to Failed', async () => {
      await service.recordTerminalFailure(JOB, new Error('gave up'));

      expect(db.feedbackSubmission.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { feedbackReportId: 'report-1', sinkSlug: 'local', status: FeedbackSubmissionStatus.Pending },
          data: expect.objectContaining({ status: FeedbackSubmissionStatus.Failed }),
        }),
      );
    });

    it('is a no-op when the row is already gone (count 0)', async () => {
      db.feedbackSubmission.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.recordTerminalFailure(JOB, new Error('x'))).resolves.toBeUndefined();
    });
  });
});
