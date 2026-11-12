import { STATUS_CODES } from 'node:http';

/**
 * Asserts that an error answer is the api's error envelope (#1260): `statusCode`
 * is the response status, `error` is its standard reason phrase, `message` is
 * plain-language copy (or a validation 400's list of it), and `code` is present
 * exactly when the refusal names one. Pass `code: null` for an error that names
 * no specific refusal.
 */
export function expectErrorEnvelope(
  response: { readonly status: number; readonly body: unknown },
  expected: { readonly status: number; readonly code: string | null },
): void {
  expect(response.status).toBe(expected.status);

  const body = response.body as Record<string, unknown>;
  expect(body['statusCode']).toBe(expected.status);
  expect(body['error']).toBe(STATUS_CODES[expected.status]);
  expect(body['message']).toEqual(
    Array.isArray(body['message']) ? expect.arrayContaining([expect.any(String)]) : expect.stringMatching(/\S/),
  );

  if (expected.code === null) {
    expect(body).not.toHaveProperty('code');
  } else {
    expect(body['code']).toBe(expected.code);
  }
}
