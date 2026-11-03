import type { ResourceType } from '@bge/database';
import { ACCESS_EXTENTS, type AccessExtent, type ResourceTypeAccess } from '@bge/permissions';
import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

/**
 * One action's answer (#757). Every action shares one `AccessExtent` schema, and
 * Swagger hoists the first property's description onto it, so all five carry
 * the same description, written for the enum.
 */
const AccessExtentProperty = () =>
  ApiProperty({
    enum: ACCESS_EXTENTS,
    enumName: 'AccessExtent',
    description: "How far the actor's permissions reach for an action: every record, some records, or none.",
  });

/**
 * OpenAPI model for one resource type's answer on `GET /users/me/access`
 * (#757): one answer per action, every action present.
 */
export class ResourceTypeAccessDto implements ResourceTypeAccess {
  @AccessExtentProperty()
  create!: AccessExtent;

  @AccessExtentProperty()
  read!: AccessExtent;

  @AccessExtentProperty()
  update!: AccessExtent;

  @AccessExtentProperty()
  delete!: AccessExtent;

  @AccessExtentProperty()
  manage!: AccessExtent;
}

/** OpenAPI model for `GET /users/me/access` (#757). */
@ApiExtraModels(ResourceTypeAccessDto)
export class UserAccessEnvelopeDto {
  @ApiProperty({
    description: 'One answer for each resource type asked about, keyed by its name.',
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(ResourceTypeAccessDto) },
  })
  access!: Partial<Record<ResourceType, ResourceTypeAccessDto>>;
}
