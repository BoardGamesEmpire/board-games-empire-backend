import { DatabaseModule, databaseConfig, databaseConfigValidationSchema } from '@bge/database';
import { env } from '@bge/env';
import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import Joi from 'joi';
import { BOOTSTRAP_OPTIONS, type BootstrapModuleOptions } from './bootstrap-options';
import { BootstrapService } from './bootstrap.service';

/**
 * The standalone context the boot sequence runs in, before the application
 * module exists (#236). Deliberately small: configuration for the
 * database URL, the database, and the service. It reads the same `.env` the
 * application reads outside production, so a developer's `DATABASE_URL` is the
 * one that gets migrated.
 */
@Module({})
export class BootstrapModule {
  static forRoot(options: BootstrapModuleOptions): DynamicModule {
    return {
      module: BootstrapModule,
      imports: [
        ConfigModule.forRoot({
          load: [databaseConfig],
          envFilePath: env.isProduction ? undefined : '.env',
          cache: true,
          isGlobal: true,
          expandVariables: true,
          validationSchema: Joi.object(databaseConfigValidationSchema),
          validationOptions: { abortEarly: true, allowUnknown: true },
        }),
        DatabaseModule,
      ],
      providers: [{ provide: BOOTSTRAP_OPTIONS, useValue: options }, BootstrapService],
      exports: [BootstrapService],
    };
  }
}
