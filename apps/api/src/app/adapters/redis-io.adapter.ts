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
        // Gateways authenticate in namespace middleware, which also installs
        // each frame's actor scope (#427). A recovered connection that skipped
        // it would be accepted without its session being checked, and every
        // frame it sent would then be refused for running outside a scope.
        skipMiddlewares: false,
      },
    };

    const server = super.createIOServer(port, serverOptions);
    server.adapter(this.adapterConstructor);
    return server;
  }
}
