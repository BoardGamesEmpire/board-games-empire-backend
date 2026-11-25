import type { ToolkitMessageCode } from './messages.js';
import { message } from './messages.js';
import type { ReportItem } from './report.js';

/**
 * A failure the plugin author CLI reports as one error with a stable code
 * (#1093). The message is the code's entry in the message table, followed by
 * `detail` when the caller has one (npm's own words, for example).
 */
export class ToolkitError extends Error {
  override readonly name = 'ToolkitError';

  constructor(
    readonly code: ToolkitMessageCode,
    readonly at?: string,
    detail?: string,
  ) {
    super(detail === undefined ? message(code) : `${message(code)} ${detail}`);
  }

  /** The error as a report item, leaving `at` out when there is none. */
  toReportItem(): ReportItem {
    return this.at === undefined
      ? { code: this.code, message: this.message }
      : { at: this.at, code: this.code, message: this.message };
  }
}
