import { errorEnvelope, toErrorCode } from './error-envelope';

describe('errorEnvelope (#1260)', () => {
  it('fills statusCode and the standard reason phrase', () => {
    expect(errorEnvelope(409, 'm')).toEqual({ statusCode: 409, error: 'Conflict', message: 'm' });
  });

  it("falls back to 'Error' for a status with no reason phrase", () => {
    expect(errorEnvelope(599, 'm').error).toBe('Error');
  });

  it('keeps extra fields beside the envelope', () => {
    expect(errorEnvelope(402, 'm', { code: 'QUOTA_EXCEEDED', limit: '5' })).toEqual({
      statusCode: 402,
      error: 'Payment Required',
      message: 'm',
      code: 'QUOTA_EXCEEDED',
      limit: '5',
    });
  });

  it('lets no field override the envelope', () => {
    expect(errorEnvelope(400, 'm', { statusCode: 200, error: 'Custom', message: 'x' })).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'm',
    });
  });
});

describe('toErrorCode (#1260)', () => {
  it.each([
    ['PluginGrantScopeIdError', 'PLUGIN_GRANT_SCOPE_ID'],
    ['TransactionDeadlockError', 'TRANSACTION_DEADLOCK'],
    ['PluginSDKVersionError', 'PLUGIN_SDK_VERSION'],
    ['PluginArtifactTooLarge', 'PLUGIN_ARTIFACT_TOO_LARGE'],
  ])('derives %s → %s', (name, code) => expect(toErrorCode(name)).toBe(code));
});
