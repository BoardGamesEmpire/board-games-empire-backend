import { createRefusalLog } from './refusal-log';

describe('createRefusalLog (#977, #1511)', () => {
  const warn = jest.fn();

  beforeEach(() => warn.mockClear());

  const logFor = () =>
    createRefusalLog({
      logger: { warn },
      refused: (name) => `Refused ${name}`,
      capReached: (max) => `Refused ${max} different names. Others are not logged for up to an hour`,
    });

  it('logs each refused name once', () => {
    const log = logFor();

    log('evil.example');
    log('evil.example');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Refused evil.example');
  });

  it('stops logging after 100 distinct names, and says so once', () => {
    const log = logFor();

    for (let name = 0; name < 150; name++) {
      log(`evil-${name}.example`);
    }

    expect(warn).toHaveBeenCalledTimes(101);
    expect(warn.mock.calls[99][0]).toBe('Refused evil-99.example');
    expect(warn.mock.calls[100][0]).toBe('Refused 100 different names. Others are not logged for up to an hour');
  });

  // Outside traffic can fill the cap, and an operator who later adds a proxy, a
  // domain or a scraper's network still needs to see what is being refused.
  it('logs again after an hour, even once the cap was reached', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const log = logFor();

    for (let name = 0; name < 150; name++) {
      log(`evil-${name}.example`);
    }

    warn.mockClear();

    now.mockReturnValue(59 * 60 * 1000);
    log('proxy-rewrite.example');
    expect(warn).not.toHaveBeenCalled();

    now.mockReturnValue(60 * 60 * 1000);
    log('proxy-rewrite.example');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Refused proxy-rewrite.example');

    log('evil-0.example');
    expect(warn).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it('reports the cap again in a later hour', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const log = logFor();

    for (let name = 0; name < 101; name++) {
      log(`evil-${name}.example`);
    }

    now.mockReturnValue(60 * 60 * 1000);
    warn.mockClear();

    for (let name = 0; name < 101; name++) {
      log(`other-${name}.example`);
    }

    expect(warn).toHaveBeenCalledTimes(101);
    expect(warn.mock.calls[100][0]).toMatch(/not logged/);

    now.mockRestore();
  });
});
