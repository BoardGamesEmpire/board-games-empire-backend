import {
  HealthCheckRequest,
  HealthCheckResponse,
  HealthCheckResponse_ServingStatus,
  PingRequest,
  PingResponse,
} from '@board-games-empire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { CreateCoordinatorDto } from './dto/create-coordinator.dto';
import { UpdateCoordinatorDto } from './dto/update-coordinator.dto';

@Injectable()
export class CoordinatorService {
  private readonly logger = new Logger(CoordinatorService.name);

  constructor(private readonly configService: ConfigService) {}

  create(createCoordinatorDto: CreateCoordinatorDto) {
    return 'This action adds a new coordinator';
  }

  findAll() {
    return `This action returns all coordinator`;
  }

  findOne(id: number) {
    return `This action returns a #${id} coordinator`;
  }

  update(id: number, updateCoordinatorDto: UpdateCoordinatorDto) {
    return `This action updates a #${id} coordinator`;
  }

  remove(id: number) {
    return `This action removes a #${id} coordinator`;
  }

  ping(request: PingRequest): PingResponse {
    return {
      correlationId: request?.correlationId || crypto.randomUUID(),
      timestampMs: Date.now(),
      coordinatorVersion: this.configService.get<string>('coordinator.version') || 'unknown',
    };
  }

  healthCheck(request: HealthCheckRequest): HealthCheckResponse {
    this.logger.log(`Health check request received for service: ${request.service}`);

    return {
      status: HealthCheckResponse_ServingStatus.SERVING,
    };
  }
}
