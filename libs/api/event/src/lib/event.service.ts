import { DatabaseService, Event } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

@Injectable()
export class EventService {
  constructor(private readonly db: DatabaseService) {}

  getEvents(): Promise<Event[]> {
    return this.db.event.findMany();
  }

  getEventById(id: string): Promise<Event | null> {
    return this.db.event.findUnique({ where: { id } });
  }

  createEvent(userId: string, createEventDto: CreateEventDto): Promise<Event> {
    throw new Error('Not implemented');
  }

  updateEvent(id: string, updateEventDto: UpdateEventDto) {
    throw new Error('Not implemented');
  }
}
