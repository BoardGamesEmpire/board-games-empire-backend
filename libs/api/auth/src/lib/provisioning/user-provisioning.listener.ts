import type { User } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AuthEvent } from '../constants';
import { UserProvisioningService } from './user-provisioning.service';

@Injectable()
export class UserProvisioningListener {
  constructor(private readonly provisioningService: UserProvisioningService) {}

  @OnEvent(AuthEvent.UserCreated)
  async handle(user: User): Promise<void> {
    await this.provisioningService.provisionNewUser(user);
  }
}
