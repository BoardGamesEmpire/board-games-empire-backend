import { SmtpSecurity } from '@bge/database';
import type { MailSettings } from './mail-settings';
import { mailFrom, smtpTransportOptions } from './smtp-options';

const settings = (over: Partial<MailSettings> = {}): MailSettings => ({
  name: 'Test Server',
  smtpHost: 'smtp.test',
  smtpPort: 587,
  smtpSecurity: SmtpSecurity.StartTls,
  smtpUser: null,
  smtpPassword: null,
  mailFromAddress: 'noreply@test.example',
  ...over,
});

describe('smtpTransportOptions', () => {
  it('requires STARTTLS for StartTls (#654)', () => {
    expect(smtpTransportOptions(settings(), null)).toMatchObject({ secure: false, requireTLS: true });
  });

  it('uses a TLS socket from the start for ImplicitTls (#654)', () => {
    const options = smtpTransportOptions(settings({ smtpSecurity: SmtpSecurity.ImplicitTls }), null);
    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBeUndefined();
  });

  it('turns TLS off for None (#654)', () => {
    expect(smtpTransportOptions(settings({ smtpSecurity: SmtpSecurity.None }), null)).toMatchObject({
      secure: false,
      ignoreTLS: true,
    });
  });

  it('carries the host and port (#654)', () => {
    expect(smtpTransportOptions(settings(), null)).toMatchObject({ host: 'smtp.test', port: 587 });
  });

  it('sets no auth without a user (#654)', () => {
    expect(smtpTransportOptions(settings(), null).auth).toBeUndefined();
  });

  it('authenticates with the decrypted password, never the stored ciphertext (#654)', () => {
    const options = smtpTransportOptions(
      settings({ smtpUser: 'mailer-user', smtpPassword: 'CIPHERTEXT' }),
      'plain-secret',
    );
    expect(options.auth).toEqual({ user: 'mailer-user', pass: 'plain-secret' });
    expect(JSON.stringify(options)).not.toContain('CIPHERTEXT');
  });

  it("answers a test email in under a minute, not nodemailer's two (#654)", () => {
    expect(smtpTransportOptions(settings(), null)).toMatchObject({
      connectionTimeout: 30_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
  });
});

describe('mailFrom', () => {
  it('names the sender after the server (#654)', () => {
    expect(mailFrom(settings())).toEqual({ name: 'Test Server', address: 'noreply@test.example' });
  });
});
