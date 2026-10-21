import { AuthModule } from '@bge/auth';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { UserProfileController } from './profile/user-profile.controller';
import { UserProfileService } from './profile/user-profile.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  // AuthModule for AuthService, which reads the caller's user for /users/me.
  imports: [AuthModule, DatabaseModule],
  controllers: [UserController, UserProfileController],
  providers: [UserService, UserProfileService],
  exports: [UserService, UserProfileService],
})
export class UserModule {}
