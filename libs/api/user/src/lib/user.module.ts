import { AuthModule } from '@bge/auth';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  // AuthModule for AuthService, which reads the caller's user for /users/me.
  imports: [AuthModule, DatabaseModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
