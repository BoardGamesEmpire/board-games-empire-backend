import { actorUserId, getActorSnapshotFromCls } from '@bge/actor-context';
import { type ExecutionContext, Injectable } from '@nestjs/common';
import type { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import type { Socket } from 'socket.io';
import { RateLimitGuard } from '../../lib/rate-limit.guard';

/**
 * Rate-limits a socket's frames by the app's throttler tiers, counted per
 * gateway handler and per user (#510). The app-wide `RateLimitGuard` never
 * runs on a gateway message, so until this guard a client could send frames
 * as fast as it liked.
 *
 * The guard's HTTP assumptions do not hold for a frame, and this one replaces
 * them for every tier:
 *
 * - The request. The guard reads a frame's socket as its request, and the
 *   socket carries no headers, so `ignoreUserAgents` would throw on every
 *   frame. The frame's handshake, which does, stands in for it.
 * - The tracker. The `default` tier brings its own, which takes precedence
 *   over the guard's `getTracker` method and reads the peer address off the
 *   request, which a frame does not carry, so every socket would share one
 *   bucket. A frame is counted against its connection's user instead.
 * - The headers. A frame's response is its payload, which has no headers to
 *   set.
 *
 * A refusal is `RateLimitGuard`'s coded 429, the one HTTP answers with, which
 * `WsErrorFilter` sends on `exception` in the frame's locale, leaving the
 * socket open (#527).
 */
@Injectable()
export class WsThrottlerGuard extends RateLimitGuard {
  protected override async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const tracker = frameTracker(requestProps.context.switchToWs().getClient<Socket>());

    return super.handleRequest({
      ...requestProps,
      throttler: { ...requestProps.throttler, setHeaders: false },
      getTracker: () => tracker,
    });
  }

  protected override getRequestResponse(context: ExecutionContext): ReturnType<ThrottlerGuard['getRequestResponse']> {
    const ws = context.switchToWs();

    return { req: ws.getClient<Socket>().handshake, res: ws.getData() };
  }
}

/**
 * The frame's user, from the actor scope the frame runs in. A frame outside
 * one is refused by `WsFrameScopeGuard` after this guard, and until then it is
 * counted against its own socket, never in a bucket every such socket shares.
 */
function frameTracker(client: Socket): string {
  const { actor } = getActorSnapshotFromCls();
  const userId = actor && actorUserId(actor);

  return userId ? `user:${userId}` : `socket:${client.id}`;
}
