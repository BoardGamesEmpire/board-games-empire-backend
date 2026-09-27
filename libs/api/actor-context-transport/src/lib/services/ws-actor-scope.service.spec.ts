import { AuditContextInternalService, AuditContextService } from '@bge/actor-context';
import type { BaseClientData } from '@bge/shared';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import { setTimeout as delay } from 'node:timers/promises';
import type { Socket } from 'socket.io';
import { WsActorScope } from './ws-actor-scope.service';

const socketOf = (userId: string): Socket =>
  ({
    data: {
      userId,
      actor: { kind: 'user', userId },
      correlationId: `connection-of-${userId}`,
    } satisfies BaseClientData,
  }) as unknown as Socket;

describe('WsActorScope', () => {
  let scope: WsActorScope;
  let auditContext: AuditContextService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [AuditContextService, AuditContextInternalService, WsActorScope],
    }).compile();

    scope = module.get(WsActorScope);
    auditContext = module.get(AuditContextService);
  });

  const snapshot = () => ({
    actor: auditContext.getActor(),
    correlationId: auditContext.getCorrelationId(),
    source: auditContext.getSource(),
  });

  it("runs a frame as its socket's actor, under the connection's correlation id, from the ws source", () => {
    expect(scope.run(socketOf('user-1'), snapshot)).toEqual({
      actor: { kind: 'user', userId: 'user-1' },
      correlationId: 'connection-of-user-1',
      source: 'ws',
    });
  });

  it("keeps each socket's actor across awaits, however their frames interleave", async () => {
    const frameOf = (userId: string, wait: number) =>
      scope.run(socketOf(userId), async () => {
        await delay(wait);
        return auditContext.getActor();
      });

    await expect(Promise.all([frameOf('user-1', 10), frameOf('user-2', 1)])).resolves.toEqual([
      { kind: 'user', userId: 'user-1' },
      { kind: 'user', userId: 'user-2' },
    ]);
  });
});
