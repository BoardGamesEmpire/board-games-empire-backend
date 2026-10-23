import { parseLogRecords, recordFields, stripAnsi, unexpectedErrors } from './logs';

/** A line as the roles' logger writes it to a container's output when it is no terminal: pino's JSON (#627). */
const jsonLine = (level: number, message: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ level, time: 1760000000000, service: 'bge-api', msg: message, ...fields });

/**
 * The failed ledger read on a first boot (#638), as DatabaseService logs it
 * through Nest: Prisma's invocation block, then the error's code and message.
 * The newlines sit inside the JSON string, so the record is still one line.
 */
const FIRST_BOOT_LEDGER_MESSAGE = [
  '',
  'Invalid `prisma.$queryRaw()` invocation:',
  '',
  '',
  'Raw query failed. Code: `42P01`. Message: `relation "_prisma_migrations" does not exist`',
].join('\n');

const ledgerError = (message = FIRST_BOOT_LEDGER_MESSAGE) => jsonLine(50, message, { context: 'DatabaseService' });

/** An `err` field as pino serializes it: part of the record's own line. */
const ERR_FIELD = {
  err: { type: 'Error', message: 'boom', stack: 'Error: boom\n    at bootstrap (/app/apps/api/dist/main.js:1:1)' },
};

/** What Node prints when a library hands an error to console.error. */
const CONSOLE_ERROR_STACK = [
  '[ioredis] Unhandled error event: Error: connect ECONNREFUSED 10.0.0.2:6379',
  '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)',
].join('\n');

describe('stripAnsi', () => {
  it('removes colour codes, so colour that leaks into the output is still read', () => {
    expect(stripAnsi('\u001b[32mINFO\u001b[39m up')).toBe('INFO up');
  });

  it('removes background colours and resets, as on a FATAL line', () => {
    expect(stripAnsi('\u001b[41mFATAL\u001b[49m \u001b[1;31mdead\u001b[0m')).toBe('FATAL dead');
  });
});

describe('parseLogRecords', () => {
  it('reads one record per JSON line, with its level named', () => {
    const lines = [
      jsonLine(10, 'tracing'),
      jsonLine(20, 'debugging'),
      jsonLine(30, 'Bootstrap complete'),
      jsonLine(40, 'careful'),
      jsonLine(50, 'failed'),
      jsonLine(60, 'dead'),
    ];

    const records = parseLogRecords(lines.join('\n'));

    expect(records).toEqual([
      { level: 'TRACE', text: lines[0] },
      { level: 'DEBUG', text: lines[1] },
      { level: 'INFO', text: lines[2] },
      { level: 'WARN', text: lines[3] },
      { level: 'ERROR', text: lines[4] },
      { level: 'FATAL', text: lines[5] },
    ]);
  });

  it('names a level between the standard ones by the standard level below it', () => {
    expect(parseLogRecords(jsonLine(35, 'custom')).map(({ level }) => level)).toEqual(['INFO']);
  });

  it('keeps output that is no record, such as a crash stack, as a record of its own without a level', () => {
    const records = parseLogRecords([jsonLine(30, 'connected'), CONSOLE_ERROR_STACK, jsonLine(30, 'next')].join('\n'));

    expect(records.map(({ level }) => level)).toEqual(['INFO', undefined, 'INFO']);
    expect(records[1].text).toBe(CONSOLE_ERROR_STACK);
  });

  it('does not take JSON that is no record for one', () => {
    const notRecords = ['{"level":"info","msg":"a string level"}', '[{"level":30}]', '{"msg":"no level"}', '42'];

    const records = parseLogRecords(notRecords.join('\n'));

    expect(records).toEqual([{ level: undefined, text: notRecords.join('\n') }]);
  });

  it('keeps output that precedes any record', () => {
    const records = parseLogRecords(['node:internal/process', 'Error: boom', jsonLine(30, 'up')].join('\n'));

    expect(records[0]).toEqual({ level: undefined, text: 'node:internal/process\nError: boom' });
  });

  it('makes no record of a blank line', () => {
    const records = parseLogRecords([jsonLine(30, 'up'), '', '   ', ''].join('\n'));

    expect(records.map(({ level }) => level)).toEqual(['INFO']);
  });

  it('keeps a blank line inside output that is no record', () => {
    const records = parseLogRecords(['Error: boom', '', '    at main (/app/main.js:1:1)'].join('\n'));

    expect(records).toEqual([{ level: undefined, text: 'Error: boom\n\n    at main (/app/main.js:1:1)' }]);
  });

  it('still strips colour codes, so a terminal-coloured line is read', () => {
    const records = parseLogRecords(`\u001b[32m${jsonLine(30, 'up')}\u001b[39m`);

    expect(records).toEqual([{ level: 'INFO', text: jsonLine(30, 'up') }]);
  });

  it('reads no records from empty output', () => {
    expect(parseLogRecords('')).toEqual([]);
  });
});

describe('unexpectedErrors', () => {
  it('reports ERROR and FATAL records, and passes a warning that carries an err', () => {
    const records = parseLogRecords(
      [
        jsonLine(30, 'fine'),
        jsonLine(40, 'retrying', ERR_FIELD),
        jsonLine(50, 'bootstrap failed'),
        jsonLine(60, 'dead', ERR_FIELD),
      ].join('\n'),
    );

    expect(unexpectedErrors(records).map(({ text }) => text)).toEqual([
      jsonLine(50, 'bootstrap failed'),
      jsonLine(60, 'dead', ERR_FIELD),
    ]);
  });

  it('reports output that is no record, which may be an error', () => {
    const records = parseLogRecords([jsonLine(30, 'connected'), CONSOLE_ERROR_STACK].join('\n'));

    expect(unexpectedErrors(records).map(({ text }) => text)).toEqual([CONSOLE_ERROR_STACK]);
  });

  // Until #638 lands, each role's first boot reads the ledger before the api
  // has created it, and Prisma reports the failed query. The roles expect it.
  it("lets the first boot's ledger read pass, and reports output it runs on over", () => {
    expect(unexpectedErrors(parseLogRecords(ledgerError()))).toEqual([]);

    const records = parseLogRecords([ledgerError(), CONSOLE_ERROR_STACK].join('\n'));

    expect(unexpectedErrors(records)).toEqual([{ level: undefined, text: CONSOLE_ERROR_STACK }]);
  });

  it('lets the ledger read pass without the invocation block before it', () => {
    const bare = FIRST_BOOT_LEDGER_MESSAGE.split('\n').at(-1) as string;

    expect(unexpectedErrors(parseLogRecords(ledgerError(bare)))).toEqual([]);
  });

  it('reports a ledger error that is not the missing table', () => {
    const brokenLedger = FIRST_BOOT_LEDGER_MESSAGE.replace(
      'relation "_prisma_migrations" does not exist',
      'column "checksum" does not exist',
    );

    expect(unexpectedErrors(parseLogRecords(ledgerError(brokenLedger)))).toHaveLength(1);
  });

  it('reports a missing table message that something follows, since it must end the message', () => {
    const trailing = `${FIRST_BOOT_LEDGER_MESSAGE}\nand then more`;

    expect(unexpectedErrors(parseLogRecords(ledgerError(trailing)))).toHaveLength(1);
  });

  it('does not pass another error that only quotes the ledger message in a field', () => {
    const quoting = jsonLine(50, 'bootstrap failed', { cause: FIRST_BOOT_LEDGER_MESSAGE });

    expect(unexpectedErrors(parseLogRecords(quoting))).toHaveLength(1);
  });
});

describe("a record's fields", () => {
  const bootstrap = parseLogRecords(
    jsonLine(30, 'Bootstrap complete', {
      state: 'behind',
      migrationsApplied: ['20260109085042_init'],
      seedsRun: true,
      unknownMigrations: [],
    }),
  )[0];

  it('reads a record’s fields, msg included', () => {
    expect(recordFields(bootstrap)).toEqual({
      level: 30,
      time: 1760000000000,
      service: 'bge-api',
      msg: 'Bootstrap complete',
      state: 'behind',
      migrationsApplied: ['20260109085042_init'],
      seedsRun: true,
      unknownMigrations: [],
    });
  });

  it('reads nothing from output that is no record', () => {
    expect(recordFields(parseLogRecords(CONSOLE_ERROR_STACK)[0])).toBeUndefined();
  });
});
