import type { Type as NestType } from '@nestjs/common';
import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

// The list-envelope builders behind `ApiPaginatedEnvelope` and
// `ApiCursorPaginatedEnvelope`. Internal to `@bge/shared`: `dto/index.ts` does
// not re-export this file, so only the public wrappers reach the package
// (#1597).

/**
 * OpenAPI schema for a list envelope whose ROW type is not modelled: the rows
 * under `resourceKey` as an array of objects with an unspecified shape, and
 * `pagination` as a real `$ref` to `metaModel`. The offset envelope and the
 * cursor envelope differ only in that meta model, so both are built here
 * (#1597).
 */
export function listEnvelopeSchema(resourceKey: string, metaModel: NestType<unknown>) {
  return {
    type: 'object' as const,
    required: [resourceKey, 'pagination'],
    properties: {
      [resourceKey]: {
        type: 'array' as const,
        items: { type: 'object' as const, additionalProperties: true },
      },
      pagination: { $ref: getSchemaPath(metaModel) },
    },
  };
}

/**
 * The 200 response for a list envelope: {@link listEnvelopeSchema} plus the
 * `＠ApiExtraModels` registration of `metaModel` that schema depends on.
 *
 * The two exist as one decorator because they are one decision and the failure
 * mode of splitting them is silent. The schema emits a `$ref` to the meta
 * model, and a `$ref` resolves only if something else in the document
 * registers that model; nothing checks the pairing. Forget the registration
 * and the build passes, the server runs, and the OpenAPI document ships a
 * dangling pointer that breaks client generation — the one reader who would
 * have noticed. Applying both here makes the omission unrepresentable.
 */
export function ApiListEnvelope(
  resourceKey: string,
  metaModel: NestType<unknown>,
  { status = 200, description = `Paginated ${resourceKey}` }: { description?: string; status?: number } = {},
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(metaModel),
    ApiResponse({ status, description, schema: listEnvelopeSchema(resourceKey, metaModel) }),
  );
}
