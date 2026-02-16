import { ApiConfigModule } from '@bge/api-config';
import { DatabaseModule, DatabaseService } from '@bge/database';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { languagesSeed } from './seeds/languages.seed';
import { rolesAndPermissionsSeed } from './seeds/roles-permissions.seed';

type Seeder = (prisma: DatabaseService, logger: Logger) => Promise<void>;

// TODO: seeds broken, fix in separate PR
@Module({
  imports: [ApiConfigModule, DatabaseModule],
})
class SeedModule {}

async function bootstrap() {
  const app = await NestFactory.create(SeedModule);

  const logger = new Logger(SeedModule.name);
  const prisma = app.get(DatabaseService);

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
    await app.close();
  }

  logger.log('All seeds completed successfully.');
}

bootstrap();
