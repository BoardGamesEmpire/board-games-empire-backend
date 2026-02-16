import { DatabaseService } from '@bge/database';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { languagesSeed } from './seeds/languages.seed';
import { rolesAndPermissionsSeed } from './seeds/roles-permissions.seed';

const configService = new ConfigService();
const prisma = new DatabaseService(configService);
const logger = new Logger('Seed');

async function main() {
  const seeds = [languagesSeed, rolesAndPermissionsSeed];

  logger.log(`Starting database seeding...${seeds.length} seed(s) to run.`);

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

  logger.log('All seeds completed successfully.');
}

main()
  .catch((error: Error) => {
    logger.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
