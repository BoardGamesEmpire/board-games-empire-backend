import { PartialType } from '@nestjs/swagger';
import { CreateEventPolicyDto } from './create-event-policy.dto';

export class UpdateEventPolicyDto extends PartialType(CreateEventPolicyDto) {}
