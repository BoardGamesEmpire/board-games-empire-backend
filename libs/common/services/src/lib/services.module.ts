import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { DEPLOYMENT_SIGNALS, DeploymentInfoService, ProcessDeploymentSignals } from './deployment-info.service';
import { EncryptionService } from './encryption.service';
import { ServiceAccountService } from './service-account.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    DeploymentInfoService,
    { provide: DEPLOYMENT_SIGNALS, useValue: ProcessDeploymentSignals },
    EncryptionService,
    ServiceAccountService,
  ],
  exports: [DeploymentInfoService, EncryptionService, ServiceAccountService],
})
export class ServicesModule {}
