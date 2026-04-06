import { createTestingModuleWithDb } from '@bge/testing';
import { EventController } from './event.controller';
import { EventService } from './event.service';

describe('EventController', () => {
  let controller: EventController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [EventService],
      controllers: [EventController],
    });

    controller = module.get(EventController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
