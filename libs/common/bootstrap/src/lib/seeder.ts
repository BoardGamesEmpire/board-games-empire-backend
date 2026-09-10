import type { PrismaClient } from '@bge/database';
import { runSeeds } from '@bge/database/seeds';
import { Logger } from '@nestjs/common';
import type { SeedsPhase } from './ports';

/** The seeds phase is `runSeeds`, the one seed path (#236). */
export class RunSeedsSeeder implements SeedsPhase {
  private readonly logger = new Logger('Seeds');

  constructor(private readonly client: PrismaClient) {}

  run(): Promise<void> {
    return runSeeds(this.client, this.logger);
  }
}
