import { I18N_CATALOG_DIR } from '@bge/i18n-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyMailError, MailFailureCode, mailTestResultMessageKey } from './mail-failure';

describe('classifyMailError', () => {
  it.each([
    ['EAUTH', MailFailureCode.AuthFailed],
    ['ENOAUTH', MailFailureCode.AuthFailed],
    ['ECONNECTION', MailFailureCode.HostUnreachable],
    ['ETIMEDOUT', MailFailureCode.HostUnreachable],
    ['EDNS', MailFailureCode.HostUnreachable],
    ['ESOCKET', MailFailureCode.HostUnreachable],
    ['ETLS', MailFailureCode.TlsFailed],
    ['EENVELOPE', MailFailureCode.Rejected],
    ['EMESSAGE', MailFailureCode.Rejected],
    ['EWHATEVER', MailFailureCode.SendFailed],
    ['constructor', MailFailureCode.SendFailed],
  ])('maps %s to %s', (code, expected) => {
    expect(classifyMailError({ code })).toBe(expected);
  });

  it.each([
    ['DEPTH_ZERO_SELF_SIGNED_CERT'],
    ['SELF_SIGNED_CERT_IN_CHAIN'],
    ['CERT_HAS_EXPIRED'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['ERR_TLS_CERT_ALTNAME_INVALID'],
    ['ERR_SSL_WRONG_VERSION_NUMBER'],
  ])('maps an ESOCKET whose originalCode is %s to a TLS failure (#654)', (originalCode) => {
    expect(classifyMailError({ code: 'ESOCKET', originalCode })).toBe(MailFailureCode.TlsFailed);
  });

  it('keeps a plain ESOCKET, or one with a network originalCode, as host unreachable (#654)', () => {
    expect(classifyMailError({ code: 'ESOCKET' })).toBe(MailFailureCode.HostUnreachable);
    expect(classifyMailError({ code: 'ESOCKET', originalCode: 'ECONNREFUSED' })).toBe(MailFailureCode.HostUnreachable);
  });

  it('falls back to a send failure for a non-string code (#654)', () => {
    expect(classifyMailError({ code: 42 })).toBe(MailFailureCode.SendFailed);
  });

  it.each([['text'], [null], [undefined], [42], [{}]])('falls back to a send failure for %p (#654)', (error) => {
    expect(classifyMailError(error)).toBe(MailFailureCode.SendFailed);
  });
});

describe('mailTestResultMessageKey', () => {
  const catalog = JSON.parse(readFileSync(join(I18N_CATALOG_DIR, 'en', 'mail.json'), 'utf-8'));

  it.each([
    [null, 'mail.test_result.sent'],
    [MailFailureCode.NotConfigured, 'mail.test_result.not_configured'],
    [MailFailureCode.SettingsUnreadable, 'mail.test_result.settings_unreadable'],
    [MailFailureCode.AuthFailed, 'mail.test_result.auth_failed'],
    [MailFailureCode.HostUnreachable, 'mail.test_result.host_unreachable'],
    [MailFailureCode.TlsFailed, 'mail.test_result.tls_failed'],
    [MailFailureCode.Rejected, 'mail.test_result.rejected'],
    [MailFailureCode.SendFailed, 'mail.test_result.send_failed'],
  ])('maps %p to %s, a key the en catalog holds (#654)', (code, key) => {
    expect(mailTestResultMessageKey(code)).toBe(key);
    const leaf = key
      .split('.')
      .slice(1)
      .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
    expect(typeof leaf).toBe('string');
  });
});
