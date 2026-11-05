import { ApiProperty } from '@nestjs/swagger';

/**
 * One expansion link, seen from the game at one end (#1069): `gameId` names
 * the game at the other end. The value is the link's own, since an expansion
 * can be standalone for one base game and not another.
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

  @ApiProperty({ description: 'Whether the expansion plays without this base game' })
  isStandalone!: boolean;
}
