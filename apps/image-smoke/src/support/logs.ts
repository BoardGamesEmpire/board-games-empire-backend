/**
 * Reading what the stack's containers wrote. The roles log through
 * pino-pretty, and colour it even when the output is not a terminal (#627).
 * A record is one line (`singleLine` in
 * libs/common/logger/src/lib/base-pino.options.ts), except that pino-pretty
 * still prints an `err` or `error` field on the indented lines under it.
 * Two libraries write to the console themselves: Prisma, and better-auth's
 * own logger. Their records run on: the lines after one, up to the next
 * record, are an error's details or stack.
 *
 * Anything else a container writes is no record of these, such as a crash's
 * stack trace or a library writing to the console. It is kept as a record of
 * its own, without a level, rather than read as part of the record before it.
 */

export interface LogRecord {
  /** The record's level, as it names it; undefined for output that is no record. */
  readonly level: string | undefined;

  /** The record's lines, without colour codes. */
  readonly text: string;
}

// Any control sequence, not only colours: nothing in a log line needs one.
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** `[01:20:12.687] INFO (bge-api/1): …`, pino-pretty's line. */
const PINO_RECORD = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] ([A-Z]+) /;

/** `prisma:error`, the line Prisma prints before a failed query's details. */
const PRISMA_RECORD = /^prisma:(error|warn|info|query)\b/;

/** `2026-10-08T13:54:09.278Z WARN [Better Auth]: …`, better-auth's own logger. */
const BETTER_AUTH_RECORD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ([A-Z]+) \[Better Auth\]: /;

const ERROR_LEVELS = new Set(['ERROR', 'FATAL']);

/**
 * The ledger read every role makes on a first boot, before the api has
 * created the table: the roles expect it to fail (#638). Only the missing
 * table passes; any other failure of that read is a broken ledger.
 */
const FIRST_BOOT_LEDGER_READ = /Code: `42P01`\. Message: `relation "_prisma_migrations" does not exist`/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, '');
}

/** A line that starts with whitespace and has more than whitespace on it. */
const INDENTED_LINE = /^\s+\S/;

interface PendingRecord {
  readonly level: string | undefined;

  /**
   * Which lines after this one, up to the next record, are part of it: only
   * indented ones, under a pino-pretty line, or any.
   */
  readonly runsOn: 'indented' | 'any';

  readonly lines: string[];
}

/** The record a line starts, if it starts one. */
function recordStartedBy(line: string): PendingRecord | undefined {
  const pino = PINO_RECORD.exec(line);
  if (pino) {
    return { level: pino[1], runsOn: 'indented', lines: [line] };
  }

  const prisma = PRISMA_RECORD.exec(line);
  if (prisma) {
    return { level: prisma[1].toUpperCase(), runsOn: 'any', lines: [line] };
  }

  const betterAuth = BETTER_AUTH_RECORD.exec(line);
  return betterAuth ? { level: betterAuth[1], runsOn: 'any', lines: [line] } : undefined;
}

/** Splits a container's output into its log records. */
export function parseLogRecords(output: string): LogRecord[] {
  const records: PendingRecord[] = [];

  for (const line of stripAnsi(output).split('\n')) {
    const started = recordStartedBy(line);
    const current = records.at(-1);

    if (started) {
      records.push(started);
    } else if (current && (current.runsOn === 'any' || INDENTED_LINE.test(line))) {
      current.lines.push(line);
    } else if (line.trim() !== '') {
      // Output that is no record: it runs on until the next record, so a
      // stack trace stays whole.
      records.push({ level: undefined, runsOn: 'any', lines: [line] });
    }
  }

  return records.map(({ level, lines }) => ({ level, text: lines.join('\n').trimEnd() }));
}

/**
 * The fields pino-pretty writes after a record's message, as JSON at the end
 * of its line. The message can hold braces of its own, so the fields are the
 * first brace from which the rest of the line parses as an object.
 */
export function recordFields(record: LogRecord): Record<string, unknown> | undefined {
  const [line] = record.text.split('\n');

  for (let start = line.indexOf('{'); start !== -1; start = line.indexOf('{', start + 1)) {
    try {
      const fields: unknown = JSON.parse(line.slice(start));
      if (typeof fields === 'object' && fields !== null && !Array.isArray(fields)) {
        return fields as Record<string, unknown>;
      }
    } catch {
      // Not where the fields start; try the next brace.
    }
  }

  return undefined;
}

function isFirstBootLedgerRead({ text }: LogRecord): boolean {
  return PRISMA_RECORD.test(text) && FIRST_BOOT_LEDGER_READ.test(text);
}

/**
 * The records that report an error, and any output that is no record, which
 * can't say whether it is one: a crash's stack trace is. The ledger read a
 * first boot expects is the one error that passes.
 */
export function unexpectedErrors(records: readonly LogRecord[]): LogRecord[] {
  return records.filter(
    (record) => (record.level === undefined || ERROR_LEVELS.has(record.level)) && !isFirstBootLedgerRead(record),
  );
}
