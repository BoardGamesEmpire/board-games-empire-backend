import type { I18nTranslations } from '@bge/i18n-core';
import type { I18nService } from 'nestjs-i18n';
import { formatLinkLifetime } from './link-lifetime';

/**
 * One outgoing mail's content. A password reset carries `expiresAt`, the ISO
 * time its token stops working, so the worker can drop a reset that waited in
 * the queue past it rather than mail a dead link (#654).
 */
export type MailMessage =
  | { kind: 'password-reset'; link: string; lifetimeMinutes: number; expiresAt: string }
  | { kind: 'test' };

export interface MailRenderContext {
  readonly lang: string;
  readonly serverName: string;
  readonly username: string;
}

/**
 * Renders a message as plain text in the recipient's language (#654). The
 * copy lives in the `mail` catalog and carries no markup, so a link stays on
 * a line of its own for any mail reader to open.
 */
export function renderMail(
  message: MailMessage,
  context: MailRenderContext,
  i18n: Pick<I18nService<I18nTranslations>, 'translate'>,
): { subject: string; text: string } {
  const { lang, serverName: server, username } = context;

  if (message.kind === 'test') {
    return {
      subject: i18n.translate('mail.test.subject', { lang, args: { server } }),
      text: i18n.translate('mail.test.body', { lang, args: { server, username } }),
    };
  }

  return {
    subject: i18n.translate('mail.password_reset.subject', { lang, args: { server } }),
    text: i18n.translate('mail.password_reset.body', {
      lang,
      args: {
        server,
        username,
        link: message.link,
        lifetime: formatLinkLifetime(message.lifetimeMinutes, lang),
      },
    }),
  };
}
