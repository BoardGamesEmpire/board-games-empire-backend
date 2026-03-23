import { createTestingModuleWithDb } from '@bge/testing';
import { UserService } from './user.service';

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      providers: [UserService],
    });

    service = module.get(UserService);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });
});
