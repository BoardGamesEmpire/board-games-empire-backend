import { createTestingModuleWithDb } from '@bge/testing';
import { EventService } from './event.service';

describe('EventService', () => {
  let service: EventService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [EventService],
    });

    service = module.get(EventService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
