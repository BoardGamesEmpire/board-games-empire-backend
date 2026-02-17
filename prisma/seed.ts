import { DatabaseService } from '@bge/database';
import { env } from '@bge/env';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import * as path from 'node:path';
import databaseConfiguration from '../libs/database/src/lib/config/database.config';
import { languagesSeed } from './seeds/languages.seed';
import { rolesAndPermissionsSeed } from './seeds/roles-permissions.seed';

const envFilePath = path.resolve(process.cwd(), '.env');
type Seeder = (prisma: DatabaseService, logger: Logger) => Promise<void>;

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath,
      load: [databaseConfiguration],
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
 * running 'npm run db:seed' without direct instantiation of DatabaseService fails to inject the ConfigService,
 * possibly due to decorator metadata not being properly emitted.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(SeedModule);

  const logger = new Logger(SeedModule.name);
  const configService = app.get(ConfigService);

  // not great but it works for now
  const prisma = new DatabaseService(configService);
  await prisma.$connect();

  const seeds: Seeder[] = [languagesSeed, rolesAndPermissionsSeed];

  logger.log(`Starting database seeding...${seeds.length} seeds to run.`);

  try {
    for (const seed of seeds) {
      try {
        logger.log(`Initializing ${seed.name}...`);
        await seed(prisma, logger);
        logger.log(`${seed.name} completed successfully.`);
      } catch (error) {
        logger.error(`Error initializing ${seed.name}:`);
        throw error;
      }
    }
  } finally {
    await prisma.$disconnect();
    await app.close();
  }

  logger.log('All seeds completed successfully.');
}

bootstrap();
