import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { SnakeCaseInterceptor, toSnakeCase, transformKeysToSnakeCase } from './snakecase.interceptor';

const mockContext = {} as ExecutionContext;

describe('toSnakeCase()', () => {
  it.each([
    ['type', 'type'],
    ['signUpDisabled', 'sign_up_disabled'],
    ['providerId', 'provider_id'],
    ['discoveryUrl', 'discovery_url'],
    ['bgeAuthBaseUrl', 'bge_auth_base_url'],
    ['bgePasskeySupported', 'bge_passkey_supported'],
    ['bgeTwoFactorSupported', 'bge_two_factor_supported'],
    ['bgeAnonymousAuthSupported', 'bge_anonymous_auth_supported'],
    ['bgeSessionEndpoint', 'bge_session_endpoint'],
    ['bgeSignOutEndpoint', 'bge_sign_out_endpoint'],
    ['deviceAuthorizationEndpoint', 'device_authorization_endpoint'],
    ['signInEndpoint', 'sign_in_endpoint'],
    ['signUpEndpoint', 'sign_up_endpoint'],
    ['authorizationEndpoint', 'authorization_endpoint'],
    ['issuer', 'issuer'],
  ])('converts "%s" → "%s"', (input, expected) => {
    expect(toSnakeCase(input)).toBe(expected);
  });
});

describe('transformKeysToSnakeCase()', () => {
  it('transforms a flat object', () => {
    expect(transformKeysToSnakeCase({ signUpDisabled: false, providerId: 'sso' })).toEqual({
      sign_up_disabled: false,
      provider_id: 'sso',
    });
  });

  it('transforms keys recursively in nested objects', () => {
    const input = {
      outerKey: {
        innerKey: 'value',
        deeplyNested: { mostInner: true },
      },
    };

    expect(transformKeysToSnakeCase(input)).toEqual({
      outer_key: {
        inner_key: 'value',
        deeply_nested: { most_inner: true },
      },
    });
  });

  it('transforms keys inside arrays of objects', () => {
    const input = [{ signUpDisabled: false }, { providerId: 'sso' }];

    expect(transformKeysToSnakeCase(input)).toEqual([{ sign_up_disabled: false }, { provider_id: 'sso' }]);
  });

  it('handles arrays nested within objects', () => {
    const input = { strategies: [{ signInEndpoint: '/sign-in' }] };

    expect(transformKeysToSnakeCase(input)).toEqual({
      strategies: [{ sign_in_endpoint: '/sign-in' }],
    });
  });

  it('does not mutate string values', () => {
    const input = { type: 'emailAndPassword', discoveryUrl: 'https://example.com' };

    expect(transformKeysToSnakeCase(input)).toEqual({
      type: 'emailAndPassword',
      discovery_url: 'https://example.com',
    });
  });

  it('passes through null without throwing', () => {
    expect(transformKeysToSnakeCase(null)).toBeNull();
  });

  it('passes through primitives unchanged', () => {
    expect(transformKeysToSnakeCase(42)).toBe(42);
    expect(transformKeysToSnakeCase('string')).toBe('string');
    expect(transformKeysToSnakeCase(true)).toBe(true);
  });

  it('passes through Date instances without transforming them to plain objects', () => {
    const date = new Date('2024-01-01');
    expect(transformKeysToSnakeCase(date)).toBe(date);
  });

  it('handles empty objects', () => {
    expect(transformKeysToSnakeCase({})).toEqual({});
  });

  it('handles empty arrays', () => {
    expect(transformKeysToSnakeCase([])).toEqual([]);
  });
});

describe('SnakeCaseInterceptor', () => {
  let interceptor: SnakeCaseInterceptor;

  beforeEach(() => {
    interceptor = new SnakeCaseInterceptor();
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  it('transforms response body keys to snake_case', (done) => {
    const body = { signUpDisabled: false, providerId: 'sso' };

    interceptor.intercept(mockContext, makeCallHandler(body)).subscribe((result) => {
      expect(result).toEqual({ sign_up_disabled: false, provider_id: 'sso' });
      done();
    });
  });

  it('transforms nested structures', (done) => {
    const body = {
      strategies: [{ signInEndpoint: 'https://example.com/sign-in' }],
    };

    interceptor.intercept(mockContext, makeCallHandler(body)).subscribe((result) => {
      expect(result).toEqual({
        strategies: [{ sign_in_endpoint: 'https://example.com/sign-in' }],
      });
      done();
    });
  });

  it('does not mutate string values', (done) => {
    const body = { type: 'email_and_password' };

    interceptor.intercept(mockContext, makeCallHandler(body)).subscribe((result) => {
      expect(result).toEqual({ type: 'email_and_password' });
      done();
    });
  });

  it('handles a null response body gracefully', (done) => {
    interceptor.intercept(mockContext, makeCallHandler(null)).subscribe((result) => {
      expect(result).toBeNull();
      done();
    });
  });

  it('handles an empty object response', (done) => {
    interceptor.intercept(mockContext, makeCallHandler({})).subscribe((result) => {
      expect(result).toEqual({});
      done();
    });
  });
});

function makeCallHandler(value: unknown): CallHandler {
  return { handle: () => of(value) };
}
