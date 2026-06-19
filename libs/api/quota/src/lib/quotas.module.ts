import { DatabaseModule } from '@bge/database';
import { QuotaModule } from '@bge/quota';
import { Module } from '@nestjs/common';
import { QuotasController } from './quotas.controller';

@Module({
  imports: [DatabaseModule, QuotaModule],
  controllers: [QuotasController],
})
export class QuotasModule {}
