import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-streams-adapter';
import { createClient, RedisClientOptions } from 'redis';
import { ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor!: ReturnType<typeof createAdapter>;

  // `allowRequest` is required, so an entrypoint can't leave `/socket.io/` without
  // the Host check by leaving it out (#977).
  constructor(
    private readonly allowRequest: NonNullable<ServerOptions['allowRequest']>,
    app?: INestApplicationContext,
  ) {
    super(app);
  }

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
      // engine.io answers `/socket.io/` ahead of Express, so the Host check on
      // the Express app never sees these handshakes (#977).
      allowRequest: this.allowRequest,
      // Socket.IO would answer its client files ahead of `allowRequest`, which
      // runs only for a handshake, and no client of this server loads them (#977).
      serveClient: false,
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
