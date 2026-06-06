import { Module } from '@nestjs/common';
import { DEPLOYMENT_SIGNALS, DeploymentInfoService, ProcessDeploymentSignals } from './deployment-info.service';

@Module({
  controllers: [],
  providers: [DeploymentInfoService, { provide: DEPLOYMENT_SIGNALS, useValue: ProcessDeploymentSignals }],
  exports: [DeploymentInfoService],
})
export class ServicesModule {}
