import { ListKind, Reach } from '@bge/database';
import { PaginatedResponseDto } from '@bge/shared';
import { ApiProperty } from '@nestjs/swagger';
import type { ListRow } from '../list-row';

/**
 * A list as the routes send it: the row, with its entry count in place of the
 * relation count's nesting. It implements the row's type, and the service
 * returns this DTO, so a field on one side only fails the typecheck.
 */
export class ListDto implements Omit<ListRow, '_count'> {
  @ApiProperty({ description: 'Unique list identifier' })
  id!: string;

  @ApiProperty({ description: 'ID of the owning user' })
  userId!: string;

  @ApiProperty({
    enum: ListKind,
    enumName: 'ListKind',
    description:
      '`Wishlist`: the games the user wants to own, one per user and never deleted. `Custom`: any other list.',
  })
  kind!: ListKind;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'List name. Null only on a wishlist, which a client shows under its own translated name.',
  })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Description, in Markdown, stored as written' })
  description!: string | null;

  @ApiProperty({
    enum: Reach,
    enumName: 'Reach',
    description: 'Who may see this list and its entries besides its owner',
  })
  reach!: Reach;

  @ApiProperty({
    description:
      "The list's place among its owner's lists, in the order the owner chose. Order by it, then by `id`; never " +
      'index by it: a removed list leaves a gap until the next reorder, and two lists created at once can share one.',
  })
  position!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ description: 'Number of entries on the list' })
  entryCount!: number;
}

/** Swagger model for the paginated envelope `GET /lists` and `GET /users/:userId/lists` return (#1241). */
export const PaginatedListResponse = PaginatedResponseDto(ListDto, 'lists');

export class ListResponseDto {
  @ApiProperty({ type: ListDto })
  list!: ListDto;
}

export class ListMessageResponseDto {
  @ApiProperty({ type: ListDto })
  list!: ListDto;

  @ApiProperty({ example: 'List created successfully' })
  message!: string;
}

export class ListsResponseDto {
  @ApiProperty({ type: [ListDto], description: 'Your lists, in their new order' })
  lists!: ListDto[];
}

export class ListDeletedResponseDto {
  @ApiProperty({ example: 'List deleted successfully' })
  message!: string;
}
