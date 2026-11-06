import { defineRequestState, hasRequestState } from '@better-auth/core/context';
import type { PrismaClient } from '@bge/database';
import type { I18nPath, I18nTranslations } from '@bge/i18n';
import { isMailConfigured, MAIL_READINESS_SELECT, MailFailureCode, type MailMessage } from '@bge/mail';
import type { MailDispatcherService } from '@bge/queue-mail';
import { Logger } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import type { I18nService } from 'nestjs-i18n';
import { fallbackLocaleRenderer } from './setting-gates';

const REQUEST_PATH = '/request-password-reset';

/** better-auth's verification identifier for a reset token: `reset-password:<token>`. */
const RESET_IDENTIFIER_PREFIX = 'reset-password:';

export type MailState = { configured: boolean; lifetimeMinutes: number } | null;

export interface PasswordResetDeps {
  /** What a reset needs from the settings row, or `null` when the row is missing. */
  readonly readMailState: () => Promise<MailState>;
  readonly enqueue: (recipientUserId: string, message: MailMessage) => Promise<void>;
  /** Renders a refusal's catalog key. */
  readonly render: (key: I18nPath) => string;
  readonly now: () => Date;
}

/**
 * The link a reset mail carries: the client's own page, with the token in the
 * fragment (#654). A fragment is never sent to a server, so the token stays out
 * of the client host's access logs and `Referer` headers. A query on
 * `redirectTo` survives and a fragment is replaced.
 */
export function resetLink(redirectTo: string, token: string): string {
  const url = new URL(redirectTo);
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.href;
}

/** True for a `redirectTo` with a scheme, such as `https://...` or an app's `bge://...`. */
function isAbsolute(redirectTo: unknown): redirectTo is string {
  if (typeof redirectTo !== 'string' || redirectTo === '') {
    return false;
  }

  try {
    new URL(redirectTo);
    return true;
  } catch {
    return false;
  }
}

/** The part of better-auth's `AuthContext` that matches a URL against `trustedOrigins`. */
interface OriginMatcher {
  isTrustedOrigin(url: string, settings?: { allowRelativePaths: boolean }): boolean;
}

/** An error's class name, read without `instanceof`, which fails across realms (a Node `URL` error in jest's). */
function errorName(error: unknown): string {
  const name = typeof error === 'object' && error !== null ? error.constructor?.name : undefined;

  return typeof name === 'string' && name !== '' ? name : typeof error;
}

/**
 * Password resets through outgoing mail (#654). `/api/auth/*` skips Nest's
 * middleware, so all of this runs in better-auth's own hooks.
 */
export function createPasswordReset(deps: PasswordResetDeps) {
  const logger = new Logger('PasswordReset');

  const refusal = (status: 'BAD_REQUEST' | 'FORBIDDEN', code: string, message: I18nPath): APIError =>
    new APIError(status, { code, message: deps.render(message) });

  // One read of the settings row per request (#654). The request hook, the
  // verification hook and `sendResetPassword` all need it, and the last two
  // run only for a registered address: reading it again in each would make
  // those answers slower, which shows which addresses hold accounts. Outside
  // a better-auth request, as in a unit test, each call reads.
  const requestMailState = defineRequestState(() => deps.readMailState());
  const readMailState = async (): Promise<MailState> =>
    (await hasRequestState()) ? requestMailState.get() : deps.readMailState();

  // The expiry the verification hook gave the token, so the mail carries the
  // moment the link stops working (#654). The hook runs before
  // `sendResetPassword` in the same request. Outside one, as in a unit test,
  // nothing is shared and the send works it out from the lifetime.
  const requestLinkExpiry = defineRequestState<Date | null>(() => null);
  const linkExpiry = (state: NonNullable<MailState>): Date =>
    new Date(deps.now().getTime() + state.lifetimeMinutes * 60_000);

  return {
    /**
     * Refuses a reset request that could not produce a usable link, or that
     * could not be mailed, before better-auth mints a token. Only the request
     * is refused: finishing a reset with a token already mailed needs no mail.
     */
    async beforeRoute(context: { path?: string; body?: unknown; context?: OriginMatcher }): Promise<void> {
      if (context.path !== REQUEST_PATH) {
        return;
      }

      const redirectTo = (context.body as { redirectTo?: unknown } | undefined)?.redirectTo;
      if (!isAbsolute(redirectTo)) {
        throw refusal(
          'BAD_REQUEST',
          'PASSWORD_RESET_REDIRECT_REQUIRED',
          'errors.auth.password_reset_redirect_required',
        );
      }

      // The mailed link carries the token to `redirectTo`, so it must be one
      // of the trusted origins. better-auth's own check on it is skipped when
      // DISABLE_ORIGIN_CHECK is set; this one is not, since a link to any
      // other origin hands that site the account (#654).
      if (!context.context?.isTrustedOrigin(redirectTo, { allowRelativePaths: false })) {
        throw refusal(
          'FORBIDDEN',
          'PASSWORD_RESET_REDIRECT_UNTRUSTED',
          'errors.auth.password_reset_redirect_untrusted',
        );
      }

      const state = await readMailState();
      if (!state?.configured) {
        throw refusal('FORBIDDEN', MailFailureCode.NotConfigured, 'errors.auth.mail_not_configured');
      }
    },

    /**
     * better-auth's `sendResetPassword`. It never throws: a failure to queue
     * must not change the response, or a 500 for registered addresses only
     * would show which hold accounts (#654). The log names neither token nor
     * link, nor the error's message, which could carry job data.
     */
    async sendResetPassword(data: { user: { id: string }; url: string; token: string }): Promise<void> {
      let state: MailState;
      try {
        state = await readMailState();
      } catch (error) {
        logger.error(`Password reset not mailed: could not read the mail settings (${errorName(error)})`);
        return;
      }

      if (!state) {
        logger.warn('Password reset not mailed: no settings row, so no mail settings');
        return;
      }

      let link: string;
      try {
        const redirectTo = new URL(data.url).searchParams.get('callbackURL');
        if (!isAbsolute(redirectTo)) {
          logger.error('Password reset not mailed: the request carried no usable redirect');
          return;
        }

        link = resetLink(redirectTo, data.token);
      } catch (error) {
        logger.error(`Password reset not mailed: could not build the reset link (${errorName(error)})`);
        return;
      }

      const expiresAt = ((await hasRequestState()) && (await requestLinkExpiry.get())) || linkExpiry(state);

      // Not awaited, so how long queueing takes never shows in the response:
      // better-auth holds the response for this function, and only a
      // registered address reaches it (#654).
      void deps
        .enqueue(data.user.id, {
          kind: 'password-reset',
          link,
          lifetimeMinutes: state.lifetimeMinutes,
          expiresAt: expiresAt.toISOString(),
        })
        .catch((error: unknown) => {
          logger.error(`Password reset not mailed: could not queue the mail (${errorName(error)})`);
        });
    },

    /**
     * `databaseHooks.verification.create.before`: a reset token lives as long
     * as the settings say. Any other verification keeps better-auth's lifetime.
     */
    async beforeVerificationCreate(verification: {
      identifier: string;
    }): Promise<{ data: { expiresAt: Date } } | undefined> {
      if (!verification.identifier.startsWith(RESET_IDENTIFIER_PREFIX)) {
        return undefined;
      }

      const state = await readMailState();
      if (!state) {
        return undefined;
      }

      const expiresAt = linkExpiry(state);
      if (await hasRequestState()) {
        await requestLinkExpiry.set(expiresAt);
      }

      return { data: { expiresAt } };
    },
  };
}

/**
 * The reset's dependencies, from the database and the mail queue. Without an
 * `I18nService`, as when the better-auth CLI builds the instance, a refusal
 * carries its catalog key.
 */
export function passwordResetDeps(
  prisma: PrismaClient,
  dispatcher: Pick<MailDispatcherService, 'enqueue'>,
  i18n?: I18nService<I18nTranslations>,
): PasswordResetDeps {
  return {
    readMailState: async () => {
      const row = await prisma.systemSetting.findUnique({
        where: { singleton: true },
        select: { ...MAIL_READINESS_SELECT, passwordResetLinkLifetimeMinutes: true },
      });

      return row && { configured: isMailConfigured(row), lifetimeMinutes: row.passwordResetLinkLifetimeMinutes };
    },
    enqueue: (recipientUserId, message) => dispatcher.enqueue(recipientUserId, message),
    render: fallbackLocaleRenderer(i18n),
    now: () => new Date(),
  };
}
