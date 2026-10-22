import { PlatformType, VocabularyLinkOrigin, VocabularyLinkStatus } from '@bge/database';
import type { VocabularyLinkView, VocabularyRecordView } from '@bge/vocabulary';
import type { Type } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

/**
 * OpenAPI models for a DataGateway's platform, category and mechanic links
 * (#718). Each class `implements` the runtime shape from `@bge/vocabulary`,
 * so a field added there and left out here is a compile error.
 */

class VocabularyRecordDto implements VocabularyRecordView {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Tabletop' })
  name!: string;

  @ApiProperty({ example: 'tabletop' })
  slug!: string;
}

export class VocabularyLinkResponseDto implements VocabularyLinkView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  gatewayId!: string;

  @ApiProperty({ description: "The DataGateway's own id for the entry", example: '6' })
  externalId!: string;

  @ApiProperty({
    enum: VocabularyLinkStatus,
    enumName: 'VocabularyLinkStatus',
    description:
      'Pending: matched no record while review was on, and accept adds one. Ignored: dismissed, so imports leave ' +
      'the entry out. Resolved: linked to `record`.',
  })
  status!: VocabularyLinkStatus;

  @ApiProperty({
    enum: VocabularyLinkOrigin,
    enumName: 'VocabularyLinkOrigin',
    description: 'Interview: written by a list job. Import: written by an import that met the entry first.',
  })
  origin!: VocabularyLinkOrigin;

  @ApiProperty({ type: VocabularyRecordDto, nullable: true, description: 'Set only while Resolved' })
  record!: VocabularyRecordDto | null;

  @ApiProperty({ description: 'The name the DataGateway sent', example: 'PC (Microsoft Windows)' })
  suppliedName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The abbreviation the DataGateway sent. Platforms only.' })
  suppliedAbbreviation!: string | null;

  @ApiProperty({
    enum: PlatformType,
    enumName: 'PlatformType',
    nullable: true,
    description: 'The platform type the DataGateway sent. Platforms only.',
  })
  suppliedPlatformType!: PlatformType | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

const envelopes = new Map<string, Type<unknown>>();

/**
 * The actions' body for one kind of link, under its own key
 * (`platformLink`, `categoryLink`, `mechanicLink`): the link as it stands
 * after the action. One class per key, so each has its own schema.
 */
export function VocabularyLinkEnvelopeDto(key: string): Type<unknown> {
  const cached = envelopes.get(key);
  if (cached) {
    return cached;
  }

  class VocabularyLinkEnvelope {}

  // The key is dynamic, so the decorator is applied as the plain function it is.
  ApiProperty({ type: VocabularyLinkResponseDto })(VocabularyLinkEnvelope.prototype, key);
  Object.defineProperty(VocabularyLinkEnvelope, 'name', {
    value: `${key.charAt(0).toUpperCase()}${key.slice(1)}EnvelopeDto`,
  });

  envelopes.set(key, VocabularyLinkEnvelope);
  return VocabularyLinkEnvelope;
}
