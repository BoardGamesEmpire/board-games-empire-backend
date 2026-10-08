import { parseLogRecords, recordFields, stripAnsi, unexpectedErrors } from './logs';

/** A line as the roles' logger writes it to a container's output: pino-pretty, coloured (#627). */
const pinoLine = (level: string, colour: number, message: string) =>
  `[01:20:12.687] \u001b[${colour}m${level}\u001b[39m (bge-api/1): \u001b[36m${message}\u001b[39m`;

/** Prisma's report of the failed ledger read on a first boot (#638), as it prints it. */
const FIRST_BOOT_LEDGER_ERROR = [
  'prisma:error ',
  'Invalid `prisma.$queryRaw()` invocation:',
  '',
  '',
  'Raw query failed. Code: `42P01`. Message: `relation "_prisma_migrations" does not exist`',
].join('\n');

/** A line of better-auth's own logger, which writes to the console, as the api's output carries it. */
const betterAuthLine = (level: string, message: string) =>
  `2026-10-08T13:54:09.278Z ${level} [Better Auth]: ${message}`;

/** An `err` field as pino-pretty 13 prints it under its record's line, `singleLine` or not. */
const ERR_FIELD = [
  '    err: {',
  '      "type": "Error",',
  '      "message": "boom",',
  '      "stack":',
  '          Error: boom',
  '              at bootstrap (/app/apps/api/dist/main.js:1:1)',
  '    }',
].join('\n');

/** What Node prints when a library hands an error to console.error. */
const CONSOLE_ERROR_STACK = [
  '[ioredis] Unhandled error event: Error: connect ECONNREFUSED 10.0.0.2:6379',
  '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)',
].join('\n');

describe('stripAnsi', () => {
  it('removes the colour codes pino-pretty writes even when the output is not a terminal', () => {
    expect(stripAnsi(pinoLine('INFO', 32, 'Bootstrap complete'))).toBe(
      '[01:20:12.687] INFO (bge-api/1): Bootstrap complete',
    );
  });

  it('removes background colours and resets, as on a FATAL line', () => {
    expect(stripAnsi('\u001b[41mFATAL\u001b[49m \u001b[1;31mdead\u001b[0m')).toBe('FATAL dead');
  });
});

describe('parseLogRecords', () => {
  it('reads one record per log line, with its level', () => {
    const records = parseLogRecords(
      [pinoLine('INFO', 32, 'Bootstrap complete'), pinoLine('WARN', 33, 'careful')].join('\n'),
    );

    expect(records.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 'INFO', text: '[01:20:12.687] INFO (bge-api/1): Bootstrap complete' },
      { level: 'WARN', text: '[01:20:12.687] WARN (bge-api/1): careful' },
    ]);
  });

  it('keeps the error fields pino-pretty indents under a log line with it, at any level', () => {
    const records = parseLogRecords(
      [pinoLine('WARN', 33, 'retrying'), ERR_FIELD, pinoLine('INFO', 32, 'retried')].join('\n'),
    );

    expect(records.map(({ level }) => level)).toEqual(['WARN', 'INFO']);
    expect(records[0].text).toBe(`[01:20:12.687] WARN (bge-api/1): retrying\n${ERR_FIELD}`);
  });

  // Apart from those fields, the roles' records are one line each, so other
  // output after one is not part of it.
  it('keeps output after a log line as a record of its own, without a level', () => {
    const records = parseLogRecords([pinoLine('INFO', 32, 'connected'), CONSOLE_ERROR_STACK].join('\n'));

    expect(records).toEqual([
      { level: 'INFO', text: '[01:20:12.687] INFO (bge-api/1): connected' },
      { level: undefined, text: CONSOLE_ERROR_STACK },
    ]);
  });

  it('keeps output that precedes any record, so nothing a crash prints is lost', () => {
    const records = parseLogRecords(['node:internal/process', 'Error: boom', pinoLine('INFO', 32, 'up')].join('\n'));

    expect(records[0]).toEqual({ level: undefined, text: 'node:internal/process\nError: boom' });
  });

  it('makes no record of a blank line after a log line', () => {
    const records = parseLogRecords([pinoLine('INFO', 32, 'up'), '', '   ', ''].join('\n'));

    expect(records.map(({ level }) => level)).toEqual(['INFO']);
  });

  it("reads Prisma's own error output as an error record, with the lines it prints after it", () => {
    const records = parseLogRecords([pinoLine('INFO', 32, 'starting'), FIRST_BOOT_LEDGER_ERROR].join('\n'));

    expect(records.map(({ level }) => level)).toEqual(['INFO', 'ERROR']);
    expect(records[1].text).toContain('_prisma_migrations');
  });

  it("reads better-auth's own lines as records, with the stack an error prints after one", () => {
    const records = parseLogRecords(
      [
        `\u001b[2m2026-10-08T13:54:09.278Z\u001b[0m \u001b[33mWARN\u001b[0m \u001b[1m[Better Auth]:\u001b[0m careful`,
        betterAuthLine('ERROR', 'sign-up failed'),
        'Error: boom',
        '    at signUp (/app/main.js:1:1)',
        pinoLine('INFO', 32, 'request completed'),
      ].join('\n'),
    );

    expect(records.map(({ level }) => level)).toEqual(['WARN', 'ERROR', 'INFO']);
    expect(records[1].text).toBe(
      `${betterAuthLine('ERROR', 'sign-up failed')}\nError: boom\n    at signUp (/app/main.js:1:1)`,
    );
  });

  it('reads no records from empty output', () => {
    expect(parseLogRecords('')).toEqual([]);
  });
});

describe('unexpectedErrors', () => {
  it('reports ERROR and FATAL records', () => {
    const records = parseLogRecords(
      [
        pinoLine('INFO', 32, 'fine'),
        pinoLine('WARN', 33, 'careful'),
        pinoLine('ERROR', 31, 'bootstrap failed'),
        `[01:20:12.688] \u001b[41mFATAL\u001b[49m (bge-api/1): \u001b[36mdead\u001b[39m`,
      ].join('\n'),
    );

    expect(unexpectedErrors(records).map(({ text }) => text)).toEqual([
      '[01:20:12.687] ERROR (bge-api/1): bootstrap failed',
      '[01:20:12.688] FATAL (bge-api/1): dead',
    ]);
  });

  it('reports an error record once, with its fields, and passes a warning that carries an error', () => {
    const records = parseLogRecords(
      [pinoLine('WARN', 33, 'retrying'), ERR_FIELD, pinoLine('ERROR', 31, 'gave up'), ERR_FIELD].join('\n'),
    );

    expect(unexpectedErrors(records).map(({ text }) => text)).toEqual([
      `[01:20:12.687] ERROR (bge-api/1): gave up\n${ERR_FIELD}`,
    ]);
  });

  it('reports output that is no record, which may be an error', () => {
    const records = parseLogRecords([pinoLine('INFO', 32, 'connected'), CONSOLE_ERROR_STACK].join('\n'));

    expect(unexpectedErrors(records).map(({ text }) => text)).toEqual([CONSOLE_ERROR_STACK]);
  });

  it("reports better-auth's errors, not its warnings", () => {
    const records = parseLogRecords(
      [betterAuthLine('WARN', 'rate limiting is best-effort'), betterAuthLine('ERROR', 'sign-up failed')].join('\n'),
    );

    expect(unexpectedErrors(records).map(({ text }) => text)).toEqual([betterAuthLine('ERROR', 'sign-up failed')]);
  });

  // Until #638 lands, each role's first boot reads the ledger before the api
  // has created it, and Prisma reports the failed query. The roles expect it.
  it("lets the first boot's ledger read pass", () => {
    expect(unexpectedErrors(parseLogRecords(FIRST_BOOT_LEDGER_ERROR))).toEqual([]);
  });

  it('reports any other Prisma error', () => {
    const other = FIRST_BOOT_LEDGER_ERROR.replace('relation "_prisma_migrations" does not exist', 'deadlock detected');

    expect(unexpectedErrors(parseLogRecords(other))).toHaveLength(1);
  });

  it('reports a ledger error that is not the missing table, as a broken ledger', () => {
    const brokenLedger = FIRST_BOOT_LEDGER_ERROR.replace(
      'relation "_prisma_migrations" does not exist',
      'column "checksum" does not exist',
    );

    expect(unexpectedErrors(parseLogRecords(brokenLedger))).toHaveLength(1);
  });
});

describe('recordFields', () => {
  const [bootstrap] = parseLogRecords(
    `[08:27:00.471] \u001b[32mINFO\u001b[39m (7): \u001b[36mBootstrap complete\u001b[39m \u001b[90m{"service":"bge-api","state":"behind","migrationsApplied":["20260109085042_init"],"seedsRun":true}\u001b[39m`,
  );

  it('reads the fields pino-pretty appends to a record', () => {
    expect(recordFields(bootstrap)).toEqual({
      service: 'bge-api',
      state: 'behind',
      migrationsApplied: ['20260109085042_init'],
      seedsRun: true,
    });
  });

  it('skips braces in the message itself', () => {
    const [mapped] = parseLogRecords(
      '[08:27:00.672] INFO (7): Mapped {/api/events, GET} route {"context":"RouterExplorer"}',
    );

    expect(recordFields(mapped)).toEqual({ context: 'RouterExplorer' });
  });

  it('reads nothing from a record without fields', () => {
    expect(recordFields(parseLogRecords('[08:27:00.672] INFO (7): no fields here')[0])).toBeUndefined();
  });
});
