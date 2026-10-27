/**
 * Reading what the stack's containers wrote. When their output is not a
 * terminal, every process role logs pino's JSON, one record per line, and
 * routes Nest's boot errors, better-auth's lines and Prisma's errors through
 * it (#627). A record is a line that parses as an object with a numeric
 * `level`; the records' own newlines, such as a stack's, sit inside their JSON
 * strings.
 *
 * Anything else a container writes is no record, such as a crash's stack trace
 * or a library writing to the console. It runs on until the next record and is
 * kept as a record of its own, without a level. The check reports it: it can't
 * say whether it is an error, and no record that passes takes in a line that
 * isn't its own.
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

/** pino's standard levels, by the number it writes in a record. */
const LEVEL_NAMES = [
  [60, 'FATAL'],
  [50, 'ERROR'],
  [40, 'WARN'],
  [30, 'INFO'],
  [20, 'DEBUG'],
] as const;

const ERROR_LEVELS = new Set(['ERROR', 'FATAL']);

/**
 * The ledger read every role makes on a first boot, before the api has
 * created the table: the roles expect it to fail (#638). Only the missing
 * table passes; any other failure of that read is a broken ledger. It must
 * end the record's message, which can open with Prisma's invocation block.
 */
const FIRST_BOOT_LEDGER_READ = /Code: `42P01`\. Message: `relation "_prisma_migrations" does not exist`$/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, '');
}

/** A level pino wrote as a number, by name: a custom one takes the standard level below it. */
function levelName(level: number): string {
  return LEVEL_NAMES.find(([floor]) => level >= floor)?.[1] ?? 'TRACE';
}

/** The record a line is, if it is one: a JSON object with a numeric `level`. */
function parseRecordLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(line);
    const isRecord =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { level?: unknown }).level === 'number';

    return isRecord ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Splits a container's output into its log records. */
export function parseLogRecords(output: string): LogRecord[] {
  const records: { level: string | undefined; lines: string[] }[] = [];

  for (const line of stripAnsi(output).split('\n')) {
    const fields = parseRecordLine(line);
    const current = records.at(-1);

    if (fields) {
      records.push({ level: levelName(fields['level'] as number), lines: [line] });
    } else if (current && current.level === undefined) {
      // Output that is no record runs on until the next record, so a stack
      // trace stays whole.
      current.lines.push(line);
    } else if (line.trim() !== '') {
      records.push({ level: undefined, lines: [line] });
    }
  }

  return records.map(({ level, lines }) => ({ level, text: lines.join('\n').trimEnd() }));
}

/** The fields of a record, `msg` included; undefined for output that is no record. */
export function recordFields(record: LogRecord): Record<string, unknown> | undefined {
  return record.level === undefined ? undefined : parseRecordLine(record.text);
}

function isFirstBootLedgerRead(record: LogRecord): boolean {
  const message = recordFields(record)?.['msg'];

  return record.level === 'ERROR' && typeof message === 'string' && FIRST_BOOT_LEDGER_READ.test(message);
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
