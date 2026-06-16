import { Module } from '@nestjs/common';
import { DEPLOYMENT_SIGNALS, DeploymentInfoService, ProcessDeploymentSignals } from './deployment-info.service';
import { EncryptionService } from './encryption.service';

@Module({
  controllers: [],
  providers: [
    DeploymentInfoService,
    { provide: DEPLOYMENT_SIGNALS, useValue: ProcessDeploymentSignals },
    EncryptionService,
  ],
  exports: [DeploymentInfoService, EncryptionService],
})
export class ServicesModule {}
