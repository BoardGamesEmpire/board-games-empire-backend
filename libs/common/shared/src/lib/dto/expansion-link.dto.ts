import { ApiProperty } from '@nestjs/swagger';

/**
 * One add-on link, seen from the game at one end (#1069): `gameId` names the
 * game at the other end. `isStandalone` is the add-on's: it follows the
 * add-on's content type, so it's the same on every link of an add-on (#1391).
 *
 * Shared because `GET /games` rows and collection rows both send it (#1070),
 * and Swagger keys a schema by class name, so a second class would collide.
 * It mirrors `ExpansionLink` from `@bge/database` without implementing it:
 * this lib imports no other `@bge/*` package. A collection row's DTO
 * implements the row type that carries `ExpansionLink`, so the two still
 * cannot drift apart unnoticed.
 */
export class ExpansionLinkDto {
  @ApiProperty({ description: 'ID of the game at the other end of the link' })
  gameId!: string;

  @ApiProperty({
    description:
      'Whether the add-on is a standalone expansion, which plays without a base game. It follows the add-on’s ' +
      'content type, so it’s the same on every link of an add-on (#1391).',
  })
  isStandalone!: boolean;
}
