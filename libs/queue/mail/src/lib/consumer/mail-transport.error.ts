import type { MailFailureCode } from '@bge/mail';

/**
 * A `sendMail` rejection, carrying only its stable code (#654). The SMTP
 * error's own text can echo what was sent, so it is not kept. It is a plain
 * `Error`, not an `UnrecoverableError`: a transport failure is worth a retry.
 * The processor logs the code from it without guessing what else failed.
 */
export class MailTransportError extends Error {
  constructor(readonly code: MailFailureCode) {
    super(code);
    this.name = 'MailTransportError';
  }
}
