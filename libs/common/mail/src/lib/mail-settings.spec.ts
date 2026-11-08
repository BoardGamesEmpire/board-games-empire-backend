import { isMailConfigured, MAIL_READINESS_SELECT, MAIL_SETTINGS_SELECT } from './mail-settings';

describe('isMailConfigured', () => {
  it('is false without a row (#654)', () => {
    expect(isMailConfigured(null)).toBe(false);
  });

  it('is false when the host is blank (#654)', () => {
    expect(isMailConfigured({ smtpHost: '  ', mailFromAddress: 'a@b.test' })).toBe(false);
  });

  it('is false when the From address is missing (#654)', () => {
    expect(isMailConfigured({ smtpHost: 'smtp.test', mailFromAddress: null })).toBe(false);
  });

  it('is true when both are set (#654)', () => {
    expect(isMailConfigured({ smtpHost: 'smtp.test', mailFromAddress: 'a@b.test' })).toBe(true);
  });
});

describe('MAIL_SETTINGS_SELECT', () => {
  // The worker sends only when the row passes the same check the api gated on.
  it('holds every column the configured check reads (#654)', () => {
    expect(MAIL_SETTINGS_SELECT).toMatchObject(MAIL_READINESS_SELECT);
  });
});
