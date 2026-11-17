import { PluginLoadRecorder } from '@bge/plugin';
import { Logger } from '@nestjs/common';
import { withdrawLoadRecordsBeforeClose } from './withdraw-load-records-before-close';

describe('withdrawLoadRecordsBeforeClose', () => {
  /** What happened, in order: the withdrawal settling and the app closing. */
  let seen: string[];
  let recorder: { withdrawLoadRecords: jest.Mock };
  let app: { get: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    seen = [];
    recorder = {
      withdrawLoadRecords: jest.fn(async () => {
        seen.push('withdrawn');
      }),
    };
    app = {
      get: jest.fn(() => recorder),
      close: jest.fn(async () => {
        seen.push('closed');
      }),
    };
  });

  it("withdraws the coordinator's plugin load records before it closes the app (#1083)", async () => {
    await withdrawLoadRecordsBeforeClose(app).close();

    expect(app.get).toHaveBeenCalledWith(PluginLoadRecorder);
    expect(seen).toEqual(['withdrawn', 'closed']);
  });

  it('still closes the app when withdrawing the records rejects, and logs it (#1083)', async () => {
    recorder.withdrawLoadRecords.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    try {
      await withdrawLoadRecordsBeforeClose(app).close();

      expect(app.close).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('db down'));
    } finally {
      error.mockRestore();
    }
  });
});
