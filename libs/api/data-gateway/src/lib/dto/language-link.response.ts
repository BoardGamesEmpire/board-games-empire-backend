import { LanguageCodeFormat, LanguageLinkOrigin, LanguageLinkStatus } from '@bge/database';
import type { LanguageLinkTagView, LanguageLinkView } from '@bge/language';
import { ApiProperty } from '@nestjs/swagger';

/**
 * OpenAPI models for a DataGateway's language links (#715). Each class
 * `implements` the runtime shape from `@bge/language`, so a field added there
 * and left out here is a compile error.
 */

class LanguageLinkTagDto implements LanguageLinkTagView {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'The canonical BCP 47 tag', example: 'pt-BR' })
  tag!: string;

  @ApiProperty()
  name!: string;
}

export class LanguageLinkResponseDto implements LanguageLinkView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  gatewayId!: string;

  @ApiProperty({
    description:
      "The DataGateway's own value, normalized: a BCP 47 tag canonicalized, an ISO code lowercased, a name's " +
      'spaces collapsed',
    example: 'Czech',
  })
  value!: string;

  @ApiProperty({ enum: LanguageCodeFormat, enumName: 'LanguageCodeFormat' })
  format!: LanguageCodeFormat;

  @ApiProperty({
    enum: LanguageLinkStatus,
    enumName: 'LanguageLinkStatus',
    description:
      'Pending: a registered language not in the vocabulary yet, which accept adds. Unresolved: needs linking to a ' +
      'tag. Ignored: dismissed. Resolved: linked to `tag`.',
  })
  status!: LanguageLinkStatus;

  @ApiProperty({ enum: LanguageLinkOrigin, enumName: 'LanguageLinkOrigin' })
  origin!: LanguageLinkOrigin;

  @ApiProperty({ type: LanguageLinkTagDto, nullable: true, description: 'Set only while Resolved' })
  tag!: LanguageLinkTagDto | null;

  @ApiProperty({ type: String, nullable: true, description: 'Supplied by the DataGateway beside the value' })
  suppliedIetfTag!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Supplied by the DataGateway beside the value' })
  suppliedIso6393!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Supplied by the DataGateway beside the value' })
  suppliedIso6391!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Supplied by the DataGateway beside the value' })
  suppliedName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Supplied by the DataGateway beside the value' })
  suppliedNativeName!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/** The actions' body: the link as it stands after the action. */
export class LanguageLinkEnvelopeDto {
  @ApiProperty({ type: LanguageLinkResponseDto })
  languageLink!: LanguageLinkResponseDto;
}
