import { NotFoundException } from '@nestjs/common';
import { ImportErrorCode, importErrorMessage, sanitizeImportError } from './sanitize-import-error';

describe('sanitizeImportError', () => {
  it('classifies NotFoundException as NOT_FOUND regardless of origin', () => {
    const error = new NotFoundException('Base game source not found for gatewayId=bgg externalId=123');

    expect(sanitizeImportError(error, 'fetch')).toEqual({
      code: ImportErrorCode.NotFound,
      message: expect.any(String),
    });
    expect(sanitizeImportError(error, 'persist')).toEqual({
      code: ImportErrorCode.NotFound,
      message: expect.any(String),
    });
  });

  it('classifies other fetch-origin errors as GATEWAY_ERROR', () => {
    const result = sanitizeImportError(new Error('14 UNAVAILABLE: internal-gateway.svc:50051'), 'fetch');
    expect(result.code).toBe(ImportErrorCode.GatewayError);
  });

  it('classifies other persist-origin errors as INTERNAL_ERROR', () => {
    const result = sanitizeImportError(new Error('duplicate key value violates unique constraint "games_pkey"'), 'persist');
    expect(result.code).toBe(ImportErrorCode.InternalError);
  });

  it('exposes a static, client-safe message for the cascade-cancellation code', () => {
    expect(importErrorMessage(ImportErrorCode.BaseImportFailed)).toBe('Skipped because the base game import failed.');
  });

  it('never includes the raw error message in the sanitized output', () => {
    const secret = 'postgres://user:hunter2@internal-db.svc.cluster.local:5432/bge';
    const result = sanitizeImportError(new Error(secret), 'persist');

    expect(result.message).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
