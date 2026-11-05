import { ArtistRole, DesignerRole, FamilyType, PublisherRole } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';
import type { GameDetailRelationRow } from '../game-detail.include';

/**
 * The relations `GET /games/:id` sends with the game (#1036). Each row class
 * implements its row type, {@link GameDetailRelationRow}, and the service annotates
 * the read with `GameDetailDto`, so a column missing from either the include
 * or these classes fails the typecheck.
 */

/** An artist, category, designer, publisher or tag: its id and name. */
export class NamedDto {
  @ApiProperty({ description: 'Unique identifier' })
  id!: string;

  @ApiProperty({ description: 'Name' })
  name!: string;
}

export class GameArtistDto implements GameDetailRelationRow<'artists'> {
  @ApiProperty({ description: 'Unique identifier of this credit' })
  id!: string;

  @ApiProperty({ enum: ArtistRole, enumName: 'ArtistRole', description: 'What the artist did on the game' })
  role!: ArtistRole;

  @ApiProperty({ type: String, nullable: true, description: 'More about the credit' })
  details!: string | null;

  @ApiProperty({ type: NamedDto })
  artist!: NamedDto;
}

export class GameCategoryDto implements GameDetailRelationRow<'categories'> {
  @ApiProperty({ description: 'Unique identifier of this link' })
  id!: string;

  @ApiProperty({ description: 'Whether this is the game’s primary category' })
  isPrimary!: boolean;

  @ApiProperty({ type: NamedDto })
  category!: NamedDto;
}

export class GameDesignerDto implements GameDetailRelationRow<'designers'> {
  @ApiProperty({ description: 'Unique identifier of this credit' })
  id!: string;

  @ApiProperty({ enum: DesignerRole, enumName: 'DesignerRole', description: 'What the designer did on the game' })
  role!: DesignerRole;

  @ApiProperty({ type: NamedDto })
  designer!: NamedDto;
}

export class FamilyDto {
  @ApiProperty({ description: 'Unique family identifier' })
  id!: string;

  @ApiProperty({ description: 'Name of the family' })
  name!: string;

  @ApiProperty({ enum: FamilyType, enumName: 'FamilyType', description: 'What ties the family’s games together' })
  familyType!: FamilyType;
}

export class GameFamilyDto implements GameDetailRelationRow<'families'> {
  @ApiProperty({ description: 'Unique identifier of this link' })
  id!: string;

  @ApiProperty({ type: FamilyDto })
  family!: FamilyDto;
}

export class MechanicDto {
  @ApiProperty({ description: 'Unique mechanic identifier' })
  id!: string;

  @ApiProperty({ description: 'Name of the mechanic' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, description: 'What the mechanic is' })
  description!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Complexity rating of the mechanic' })
  complexity!: number | null;
}

export class GameMechanicDto implements GameDetailRelationRow<'mechanics'> {
  @ApiProperty({ description: 'Unique identifier of this link' })
  id!: string;

  @ApiProperty({ type: MechanicDto })
  mechanic!: MechanicDto;
}

export class GamePublisherDto implements GameDetailRelationRow<'publishers'> {
  @ApiProperty({ description: 'Unique identifier of this credit' })
  id!: string;

  @ApiProperty({ enum: PublisherRole, enumName: 'PublisherRole', description: 'What the publisher did for the game' })
  role!: PublisherRole;

  @ApiProperty({ type: NamedDto })
  publisher!: NamedDto;
}

export class GameTagDto implements GameDetailRelationRow<'tags'> {
  @ApiProperty({ description: 'Unique identifier of this link' })
  id!: string;

  @ApiProperty({ type: NamedDto })
  tag!: NamedDto;
}
