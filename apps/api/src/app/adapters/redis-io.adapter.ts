import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { createClient, RedisClientOptions } from 'redis';
import { ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor!: ReturnType<typeof createAdapter>;

  async connectToRedis(configService: ConfigService): Promise<void> {
    const options = configService.getOrThrow<RedisClientOptions>('redis.websocket');
    const redisClient = createClient({
      ...options,
      // TODO: Make this configurable
      database: 1,
    });
    await redisClient.connect();

    this.adapterConstructor = createAdapter(redisClient);
  }

  override createIOServer(port: number, options?: ServerOptions): any {
    const serverOptions = <ServerOptions>{
      ...options,
      connectionStateRecovery: {
        // Make configurable?
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
      },
    };

    const server = super.createIOServer(port, serverOptions);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
