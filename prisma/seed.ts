import { DatabaseService, databaseConfig } from '@bge/database';
import { env } from '@bge/env';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as path from 'node:path';
import { runSeeds } from './seeds/run-seeds';

const envFilePath = path.resolve(process.cwd(), '.env');

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath,
      load: [databaseConfig],
      cache: true,
      isGlobal: true,
      expandVariables: true,
      validationOptions: {
        abortEarly: true,
        cache: !env.isProduction,
        debug: !env.isProduction,
        stack: !env.isProduction,
      },
    }),
  ],
})
class SeedModule {}

/**
 * CLI entrypoint only (`npm run db:seed` / `npx prisma db seed`). The seed
 * set and the loop live in `./seeds/run-seeds` so other callers — notably
 * #236's bootstrap orchestration — can seed a database in-process without a
 * child Nest bootstrap.
 *
 * running 'npm run db:seed' without direct instantiation of DatabaseService fails to inject the ConfigService,
 * possibly due to decorator metadata not being properly emitted.
 *
 * @todo explore a migrations and seeds service that can run on startup (#236)
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(SeedModule);

  const logger = new Logger(SeedModule.name);
  const configService = app.get(ConfigService);

  // not great but it works for now
  const prisma = new DatabaseService(configService);
  await prisma.$connect();

  try {
    await runSeeds(prisma, logger);
  } finally {
    await prisma.$disconnect();
    await app.close();
  }
}

bootstrap();
