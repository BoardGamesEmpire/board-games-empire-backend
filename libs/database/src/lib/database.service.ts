import { env } from '@bge/env';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './client';

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  constructor(private readonly configService: ConfigService) {
    Logger.log('Initializing DatabaseService', DatabaseService.name);

    const connectionString = configService.getOrThrow<string>('database.url');
    const schema = new URL(connectionString).searchParams.get('schema') ?? configService.get<string>('database.schema');

    super({
      adapter: new PrismaPg(
        {
          connectionString,
        },
        {
          schema,
        },
      ),
      log: env.isDevelopment ? ['query', 'info', 'warn', 'error'] : ['error'],
    });
  }

  public async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Database connected');
    } catch (error) {
      this.logger.error(error);
      throw error;
    }

    if (this.configService.get<string>('database.logQueries')) {
      // @ts-expect-error - TS likes to whine about non-existent problems
      this.$on('query', (e: Prisma.QueryEvent) => {
        this.logger.log('Query: ' + e.query);
        this.logger.log('Params: ' + e.params);
        this.logger.log('Duration: ' + e.duration + 'ms');
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
