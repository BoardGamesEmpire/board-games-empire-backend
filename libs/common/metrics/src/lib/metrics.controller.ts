import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { PrometheusController } from '@willsoto/nestjs-prometheus';

@ApiTags('metrics')
@Controller('metrics')
@AllowAnonymous()
export class MetricsController extends PrometheusController {}
