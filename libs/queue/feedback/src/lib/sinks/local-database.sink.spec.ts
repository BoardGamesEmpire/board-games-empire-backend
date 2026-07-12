import type { FeedbackReport } from '@bge/database';
import type { FeedbackSink } from '../contract/feedback-sink';
import { LocalDatabaseSink } from './local-database.sink';

const report = { id: 'report-1' } as FeedbackReport;

describe('LocalDatabaseSink', () => {
  const sink: FeedbackSink = new LocalDatabaseSink();

  it('is the bundled sink with slug "local"', () => {
    expect(sink.slug).toBe('local');
    expect(sink.bundled).toBe(true);
  });

  it('accepts every category (no acceptsCategory filter)', () => {
    expect(sink.acceptsCategory).toBeUndefined();
  });

  it('acknowledges the report by pointing the submission back at it', async () => {
    await expect(sink.submit(report, { submissionId: 'sub-1' })).resolves.toEqual({
      externalId: 'report-1',
      externalUrl: null,
    });
  });
});
