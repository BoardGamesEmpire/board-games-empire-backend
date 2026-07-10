import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { UserCreatedEvent } from '../events/auth.events';
import { UserProvisioningService } from './user-provisioning.service';

@Injectable()
export class UserProvisioningListener {
  constructor(private readonly provisioningService: UserProvisioningService) {}

  @OnEvent(UserCreatedEvent.eventName)
  async handle(event: UserCreatedEvent): Promise<void> {
    await this.provisioningService.provisionNewUser(event.subjectId);
  }
}
