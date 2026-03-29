import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';

@Module({
  imports: [DatabaseModule],
})
export class GameSearchModule {}
