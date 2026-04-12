import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AddGameToListDto {
  @ApiProperty({ description: 'ID of a GameCollection entry owned by the attendee' })
  @IsString()
  collectionId!: string;
}
