import { DataGatewayCapability, DataGatewaySectionFailure } from '@bge/database';
import { wrapJobData, type JobMetaEnvelope } from '@bge/queue-actor-context';
import { InMemoryGatewayDriver } from '@boardgamesempire/gateway-driver-contract-testing';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { VocabularySectionJob } from './constants/vocabulary-section.constants';
import { GatewayRoutingRefusedError } from './errors/gateway-routing-refused.error';
import { VocabularySectionError } from './errors/vocabulary-section.error';
import type { GatewayInterviewService } from './gateway-interview.service';
import type { GatewayRegistryService } from './gateway-registry.service';
import { VocabularySectionProcessor } from './vocabulary-section.processor';
import type { VocabularySectionService } from './vocabulary-section.service';

const { ListPlatforms } = DataGatewayCapability;

const makeJob = (attemptsMade = 0, attempts = 3) =>
  ({
    id: 'g1-ListPlatforms',
    queueName: '{bge.gateway.vocabulary}',
    data: wrapJobData<VocabularySectionJob>(
      { gatewayId: 'g1', capability: ListPlatforms },
      { actor: { kind: 'system', reason: 'gateway-registry:vocabulary-section' }, correlationId: 'corr-1' },
    ),
    attemptsMade,
    opts: { attempts },
  }) as unknown as Job<VocabularySectionJob & JobMetaEnvelope>;

describe('VocabularySectionProcessor', () => {
  let registry: { resolve: jest.Mock };
  let interviews: { runSection: jest.Mock };
  let sections: { load: jest.Mock; recordLoaded: jest.Mock; recordFailed: jest.Mock };
  let runWith: jest.Mock;
  let processor: VocabularySectionProcessor;
  let driver: InMemoryGatewayDriver;
  let signal: AbortSignal;

  beforeEach(() => {
    driver = new InMemoryGatewayDriver();
    signal = new AbortController().signal;
    registry = { resolve: jest.fn().mockResolvedValue(driver) };
    interviews = {
      runSection: jest.fn((_gatewayId: string, _driver: unknown, section: (signal: AbortSignal) => unknown) =>
        section(signal),
      ),
    };
    sections = {
      load: jest.fn().mockResolvedValue(undefined),
      recordLoaded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    runWith = jest.fn((_init: unknown, fn: () => unknown) => fn());

    processor = new VocabularySectionProcessor(
      registry as unknown as GatewayRegistryService,
      interviews as unknown as GatewayInterviewService,
      sections as unknown as VocabularySectionService,
    );
    // ActorAwareWorkerHost injects auditContext as a property; set it directly.
    (processor as unknown as { auditContext: { runWith: typeof runWith } }).auditContext = { runWith };
  });

  afterEach(() => jest.restoreAllMocks());

  it('loads the section through the driver the gateway registry resolves, then records it loaded', async () => {
    await processor.process(makeJob());

    expect(runWith).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'queue',
        actor: { kind: 'system', reason: 'gateway-registry:vocabulary-section' },
        correlationId: 'corr-1',
      }),
      expect.any(Function),
    );
    expect(registry.resolve).toHaveBeenCalledWith('g1', ListPlatforms);
    expect(interviews.runSection).toHaveBeenCalledWith('g1', driver, expect.any(Function));
    expect(sections.load).toHaveBeenCalledWith('g1', ListPlatforms, driver, signal);
    expect(sections.recordLoaded).toHaveBeenCalledWith('g1', ListPlatforms, expect.any(Date));
  });

  // The capability was switched off or dropped, or the DataGateway was
  // disabled or deleted, after the job was queued (#715, #718).
  it('ends quietly, asking and recording nothing, when the registry refuses the capability', async () => {
    registry.resolve.mockRejectedValue(new GatewayRoutingRefusedError('g1', 'switched_off', ListPlatforms));

    await expect(processor.process(makeJob())).resolves.toBeUndefined();

    expect(interviews.runSection).not.toHaveBeenCalled();
    expect(sections.load).not.toHaveBeenCalled();
    expect(sections.recordLoaded).not.toHaveBeenCalled();
    expect(sections.recordFailed).not.toHaveBeenCalled();
  });

  it('fails the attempt, so BullMQ retries it, when the section fails', async () => {
    const failure = new VocabularySectionError(DataGatewaySectionFailure.ListFailed, new Error('upstream timeout'));
    sections.load.mockRejectedValue(failure);

    await expect(processor.process(makeJob())).rejects.toBe(failure);
    expect(sections.recordLoaded).not.toHaveBeenCalled();
  });

  it('fails the attempt, recording nothing yet, when its connection is replaced mid-load', async () => {
    const reason = abandonSection();

    await expect(processor.process(makeJob())).rejects.toBe(reason);

    expect(sections.recordLoaded).not.toHaveBeenCalled();
    expect(sections.recordFailed).not.toHaveBeenCalled();
  });

  // A closed connection isn't the section failing, so the last try records
  // no ListFailed; the list loads after the next interview (#718).
  it('ends quietly, recording nothing, when its connection is replaced on the last try', async () => {
    abandonSection();

    await expect(processor.process(makeJob(2, 3))).resolves.toBeUndefined();

    expect(sections.recordLoaded).not.toHaveBeenCalled();
    expect(sections.recordFailed).not.toHaveBeenCalled();
  });

  it('still fails the last try when the section fails without being abandoned', async () => {
    const failure = new VocabularySectionError(DataGatewaySectionFailure.ListFailed, new Error('upstream timeout'));
    sections.load.mockRejectedValue(failure);

    await expect(processor.process(makeJob(2, 3))).rejects.toBe(failure);
  });

  // Retrying won't make the DataGateway implement the list (#718).
  it('records ListUnsupported on the first try and ends the job, without retrying', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    sections.load.mockRejectedValue(
      new VocabularySectionError(DataGatewaySectionFailure.ListUnsupported, new Error('12 UNIMPLEMENTED')),
    );

    await expect(processor.process(makeJob())).resolves.toBeUndefined();

    expect(sections.recordFailed).toHaveBeenCalledWith(
      'g1',
      ListPlatforms,
      DataGatewaySectionFailure.ListUnsupported,
      expect.any(Date),
    );
    expect(sections.recordLoaded).not.toHaveBeenCalled();
  });

  /** Aborts the section's signal mid-load, as abandon() does, and answers with the reason. */
  function abandonSection(): Error {
    const reason = new Error('The interview of DataGateway g1 was abandoned: its connection was closed or replaced');
    const abandonment = new AbortController();
    interviews.runSection.mockImplementation(
      async (_gatewayId: string, _driver: unknown, section: (signal: AbortSignal) => Promise<unknown>) => {
        const loading = section(abandonment.signal);
        abandonment.abort(reason);
        await loading;
        abandonment.signal.throwIfAborted();
      },
    );
    return reason;
  }

  describe('onFailed', () => {
    it('records the failure only after the last attempt, with the section error’s code', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const failure = new VocabularySectionError(DataGatewaySectionFailure.LinkFailed, new Error('deadlock detected'));

      await processor.onFailed(makeJob(2, 3), failure);
      expect(sections.recordFailed).not.toHaveBeenCalled();

      await processor.onFailed(makeJob(3, 3), failure);
      expect(sections.recordFailed).toHaveBeenCalledWith(
        'g1',
        ListPlatforms,
        DataGatewaySectionFailure.LinkFailed,
        expect.any(Date),
      );
      expect(runWith).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'corr-1' }), expect.any(Function));
    });

    it('records ListFailed for an error that carries no code', async () => {
      await processor.onFailed(makeJob(3, 3), new Error('connection refused'));

      expect(sections.recordFailed).toHaveBeenCalledWith(
        'g1',
        ListPlatforms,
        DataGatewaySectionFailure.ListFailed,
        expect.any(Date),
      );
    });

    it('never throws when recording the failure fails', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      sections.recordFailed.mockRejectedValue(new Error('database gone'));

      await expect(processor.onFailed(makeJob(3, 3), new Error('boom'))).resolves.toBeUndefined();
    });
  });
});
