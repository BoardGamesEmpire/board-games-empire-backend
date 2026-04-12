import { PartialType } from '@nestjs/swagger';
import { CreateEventOccurrenceDto } from '../occurrence/dto/create-event-occurrence.dto';

export class UpdateEventOccurrenceDto extends PartialType(CreateEventOccurrenceDto) {}
