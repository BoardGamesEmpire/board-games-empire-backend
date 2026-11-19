import { FALLBACK_LOCALE, PRIVACY_POLICY_DIR } from '@bge/i18n';
import { displayName } from '@bge/locale';
import type { OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { PolicyFileProblem, PolicyText } from './policy-file';
import { parsePolicyFile, POLICY_FILE_EXTENSION, policyFileLanguage } from './policy-file';
import { PRIVACY_POLICY_MAX_LENGTH } from './privacy-policy.constants';

/**
 * The directory the privacy policy files are read from (#934). Without it,
 * the server reads the standard privacy policy it ships.
 */
export const PRIVACY_POLICY_DIR_TOKEN = Symbol('PRIVACY_POLICY_DIR');

/** The file the server can't start without: the policy in the fallback language. */
const FALLBACK_FILE = `${FALLBACK_LOCALE}${POLICY_FILE_EXTENSION}`;

/** How the boot errors start. They go to the log, so they're English only. */
const NEEDS_FALLBACK = `The server needs a privacy policy in ${displayName(FALLBACK_LOCALE) ?? FALLBACK_LOCALE}`;

/**
 * An entry that names the fallback language's file and can't be used. It
 * fails the boot only when no other entry gives the policy in that language.
 */
interface FallbackProblem {
  cause?: unknown;

  /** What is wrong with it, following "<name> in <directory>". */
  detail: string;

  name: string;
}

/** What each problem means, for the log. */
const PROBLEMS: Readonly<Record<PolicyFileProblem['problem'], string>> = {
  empty: 'nothing is left of its text once unsafe content is removed',
  'no-valid-date':
    'it must start with three lines and nothing else: "---", then "updated: YYYY-MM-DD" with a real date, then "---"',
  'not-a-language-tag': `its name must be a language tag and ${POLICY_FILE_EXTENSION}, such as ${FALLBACK_FILE} or pt-BR${POLICY_FILE_EXTENSION}`,
  'too-complex': 'its text uses bold, italic or strikethrough too many times to keep its headings and lists',
  'too-long': `its text is longer than ${PRIVACY_POLICY_MAX_LENGTH} characters`,
};

/**
 * The privacy policy files, read once at boot (#934): one `<language tag>.md`
 * per language, in a directory that holds nothing else, so an operator can
 * mount their own files over the standard privacy policy. A change to the
 * files applies on restart.
 *
 * The boot fails when there is no usable file in the fallback language. Any
 * other file that can't be used is logged and skipped, so one mistake in a
 * second language doesn't stop the server, and readers of that language get
 * another until it's fixed. So is an unusable alias of the fallback's file
 * (`EN.md`, `eng.md`) beside a usable one: which of them sorts first must not
 * decide whether the server starts.
 *
 * Entries whose names start with a dot, and directories, are skipped without
 * a word, and symlinks are followed: a Kubernetes ConfigMap mounts each file
 * as a symlink through `..data`, a symlink to a timestamped directory.
 */
@Injectable()
export class PrivacyPolicyFilesService implements OnModuleInit {
  private readonly logger = new Logger(PrivacyPolicyFilesService.name);
  private texts: ReadonlyMap<string, PolicyText> = new Map();
  private tags: readonly string[] = [];

  constructor(@Optional() @Inject(PRIVACY_POLICY_DIR_TOKEN) private readonly dir: string = PRIVACY_POLICY_DIR) {}

  /** The policy file's text in a canonical language tag, if there is one. */
  get(language: string): PolicyText | undefined {
    return this.texts.get(language);
  }

  /** The languages there is a policy file for, as canonical tags, sorted. */
  languages(): readonly string[] {
    return this.tags;
  }

  async onModuleInit(): Promise<void> {
    const texts = new Map<string, PolicyText>();
    const files = new Map<string, string>();
    const fallbackProblems: FallbackProblem[] = [];

    for (const name of await this.entries()) {
      const text = await this.read(name, fallbackProblems);
      if (!text) {
        continue;
      }

      const kept = files.get(text.language);
      if (kept) {
        this.logger.warn(
          `Skipped the privacy policy file ${name} because ${kept} already gives the policy in ${text.language}.`,
        );
        continue;
      }

      texts.set(text.language, text);
      files.set(text.language, name);
    }

    const fallback = files.get(FALLBACK_LOCALE);
    if (fallback === undefined) {
      const [problem] = fallbackProblems;
      if (problem) {
        throw new Error(
          `${NEEDS_FALLBACK}, but ${problem.name} in ${this.dir} ${problem.detail}.`,
          problem.cause === undefined ? undefined : { cause: problem.cause },
        );
      }

      throw new Error(
        `${NEEDS_FALLBACK}, but there is no ${FALLBACK_FILE} in ${this.dir}. ` +
          'Put the standard privacy policy back, or write your own.',
      );
    }

    for (const { name, detail } of fallbackProblems) {
      this.logger.warn(
        `Skipped the privacy policy entry ${name}, which ${detail}. ${fallback} gives the policy in ${FALLBACK_LOCALE}.`,
      );
    }

    this.texts = texts;
    this.tags = [...texts.keys()].sort();
  }

  /**
   * The directory's entries, sorted, so which of two files for one language
   * is kept never depends on the file system.
   */
  private async entries(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).sort();
    } catch (error) {
      throw new Error(`${NEEDS_FALLBACK}, but the directory ${this.dir} can't be read.`, { cause: error });
    }
  }

  /**
   * One entry's text, or undefined for an entry that is skipped. An unusable
   * entry naming the fallback's file goes into `fallbackProblems` instead of
   * the log.
   */
  private async read(name: string, fallbackProblems: FallbackProblem[]): Promise<PolicyText | undefined> {
    if (name.startsWith('.')) {
      return undefined;
    }

    let entry: Buffer | 'not-a-file' | 'not-markdown';
    try {
      entry = await this.readEntry(name);
    } catch (error) {
      const reason = `(unreadable): ${error instanceof Error ? error.message : String(error)}`;
      return this.unusable(fallbackProblems, name, reason, error);
    }

    if (entry === 'not-a-file') {
      // A directory is skipped without a word, except where the fallback's
      // file belongs: a bind mount makes one there when its file is missing.
      if (isFallbackFile(name)) {
        fallbackProblems.push({
          detail: 'is not a file. A bind mount makes a directory where the file it names is missing on the host',
          name,
        });
      }

      return undefined;
    }

    if (entry === 'not-markdown') {
      this.logger.warn(
        `Skipped ${name} in the privacy policy directory: a privacy policy file is named ` +
          `<language tag>${POLICY_FILE_EXTENSION}, such as ${FALLBACK_FILE}.`,
      );
      return undefined;
    }

    const parsed = parsePolicyFile(name, entry);
    if ('problem' in parsed) {
      return this.unusable(fallbackProblems, name, `(${parsed.problem}): ${PROBLEMS[parsed.problem]}`);
    }

    return parsed;
  }

  /** An entry's bytes when it is a Markdown file, or what it is instead. */
  private async readEntry(name: string): Promise<Buffer | 'not-a-file' | 'not-markdown'> {
    const file = path.join(this.dir, name);
    // `stat` follows a symlink to what it points at.
    if (!(await stat(file)).isFile()) {
      return 'not-a-file';
    }

    if (!name.endsWith(POLICY_FILE_EXTENSION)) {
      return 'not-markdown';
    }

    return readFile(file);
  }

  /**
   * Skips an entry that can't be used: one naming the fallback's file goes into
   * `fallbackProblems`, decided once every entry is read, and any other is
   * logged.
   */
  private unusable(fallbackProblems: FallbackProblem[], name: string, reason: string, cause?: unknown): undefined {
    if (isFallbackFile(name)) {
      fallbackProblems.push({ cause, detail: `can't be used ${reason}`, name });
      return undefined;
    }

    this.logger.warn(`Skipped the privacy policy file ${name} ${reason}. Fix it and restart the server to serve it.`);
    return undefined;
  }
}

/**
 * Whether an entry is the fallback language's policy file, whatever case or
 * alias its name is written in (`en.md`, `EN.md`, `eng.md`).
 */
function isFallbackFile(name: string): boolean {
  return name.endsWith(POLICY_FILE_EXTENSION) && policyFileLanguage(name) === FALLBACK_LOCALE;
}
