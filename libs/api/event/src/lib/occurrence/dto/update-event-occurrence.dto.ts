import { PartialType } from '@nestjs/swagger';
import { CreateEventOccurrenceDto } from './create-event-occurrence.dto';

export class UpdateEventOccurrenceDto extends PartialType(CreateEventOccurrenceDto) {}
