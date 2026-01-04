import { Controller } from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { PrometheusController } from '@willsoto/nestjs-prometheus';

@Controller('metrics')
@AllowAnonymous()
export class MetricsController extends PrometheusController {}
