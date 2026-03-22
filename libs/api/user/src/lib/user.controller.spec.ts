import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { UserController } from './user.controller';
import { UserService } from './user.service';

describe('UserController', () => {
  let controller: UserController;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      overrideGuards: [AuthGuard, PoliciesGuard],
      providers: [UserService],
      controllers: [UserController],
    });

    controller = module.get(UserController);
  });

  it('should be defined', () => {
    expect(controller).toBeTruthy();
  });
});
