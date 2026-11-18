import type { Actor, AuditContextService } from '@bge/actor-context';
import type { SafeHttpRequestOptions, SecureHttpService } from '@bge/secure-http';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PluginConfigService } from '../config/plugin-config.service';
import { PluginEmitNotDeclaredError } from '../loader/loader.errors';
import { PluginContextFactory } from './plugin-context.factory';

describe('PluginContextFactory', () => {
  const slug = 'demo-sink';
  const pluginId = 'plugin-1';
  const declaredEvent = `plugin.${slug}.digest-sent`;

  let emitter: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
  let configService: jest.Mocked<Pick<PluginConfigService, 'snapshotFor'>>;
  let auditContext: jest.Mocked<Pick<AuditContextService, 'getActor'>>;
  let secureHttp: { request: jest.Mock };
  let factory: PluginContextFactory;

  const manifest = (emits: readonly string[], outboundDomains: readonly string[] = []): PluginManifest =>
    ({
      events: { subscribes: [], emits: [...emits] },
      network: { outboundDomains: [...outboundDomains] },
    }) as unknown as PluginManifest;

  beforeEach(() => {
    emitter = { emit: jest.fn() } as unknown as jest.Mocked<Pick<EventEmitter2, 'emit'>>;
    configService = {
      snapshotFor: jest.fn().mockReturnValue(Object.freeze({ apiKey: 'k' })),
    } as unknown as jest.Mocked<Pick<PluginConfigService, 'snapshotFor'>>;
    auditContext = { getActor: jest.fn().mockReturnValue(null) } as unknown as jest.Mocked<
      Pick<AuditContextService, 'getActor'>
    >;
    secureHttp = {
      request: jest.fn().mockResolvedValue({
        status: 200,
        statusText: 'OK',
        headers: {},
        setCookie: [],
        body: new ArrayBuffer(0),
        finalUrl: 'https://api.one.example/',
        redirectCount: 0,
      }),
    };

    factory = new PluginContextFactory(
      emitter as unknown as EventEmitter2,
      configService as unknown as PluginConfigService,
      auditContext as unknown as AuditContextService,
      secureHttp as unknown as SecureHttpService,
    );
  });

  it('closes the context over the plugin identity', () => {
    const context = factory.create({ pluginId, slug, manifest: manifest([declaredEvent]) });

    expect(context.pluginId).toBe(pluginId);
    expect(context.slug).toBe(slug);
  });

  describe('events', () => {
    it('emits manifest-declared events through the host emitter', () => {
      const context = factory.create({ pluginId, slug, manifest: manifest([declaredEvent]) });
      const payload = { digestId: 'd-1' };

      context.events.emit(declaredEvent, payload);

      expect(emitter.emit).toHaveBeenCalledWith(declaredEvent, payload);
    });

    it('throws PluginEmitNotDeclaredError for an undeclared event and emits nothing', () => {
      const context = factory.create({ pluginId, slug, manifest: manifest([declaredEvent]) });

      expect(() => context.events.emit(`plugin.${slug}.other-event`, {})).toThrow(PluginEmitNotDeclaredError);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('rejects lifecycle routing keys — they are never in a manifest allowlist', () => {
      const context = factory.create({ pluginId, slug, manifest: manifest([declaredEvent]) });

      expect(() => context.events.emit('plugin.installed', {})).toThrow(PluginEmitNotDeclaredError);
    });

    it('snapshots the allowlist at construction: later manifest mutation cannot widen it', () => {
      const mutable = manifest([declaredEvent]);
      const context = factory.create({ pluginId, slug, manifest: mutable });

      (mutable.events.emits as string[]).push(`plugin.${slug}.smuggled`);

      expect(() => context.events.emit(`plugin.${slug}.smuggled`, {})).toThrow(PluginEmitNotDeclaredError);
    });
  });

  describe('config', () => {
    it('reads the current snapshot for this plugin on every access', () => {
      const context = factory.create({ pluginId, slug, manifest: manifest([]) });

      expect(context.config.current()).toEqual({ apiKey: 'k' });
      expect(configService.snapshotFor).toHaveBeenCalledWith(slug);
    });
  });

  describe('actor', () => {
    describe('actor', () => {
      it('exposes a projected, frozen view of the CLS actor rather than the CLS object', () => {
        const actor: Actor = {
          kind: 'plugin',
          pluginId,
          unit: { scopeType: 'Server' },
          trigger: { kind: 'system', reason: 'test' },
        };
        auditContext.getActor.mockReturnValue(actor);

        const context = factory.create({ pluginId, slug, manifest: manifest([]) });
        const view = context.actor.current();

        expect(view).toEqual({
          kind: 'plugin',
          pluginId,
          unit: { scopeType: 'Server' },
          trigger: { kind: 'system', reason: 'test' },
        });
        expect(view).not.toBe(actor);
        expect(Object.isFrozen(view)).toBe(true);
      });

      it('returns null when no actor is populated', () => {
        auditContext.getActor.mockReturnValue(null);

        const context = factory.create({ pluginId, slug, manifest: manifest([]) });

        expect(context.actor.current()).toBeNull();
      });
    });
  });

  describe('http', () => {
    // Each context closes over its own plugin manifest's outbound domains, so
    // one plugin's declaration never lets another out (#1083).
    it("gives each plugin an http client held to its own plugin manifest's hosts (#1083)", async () => {
      const one = factory.create({ pluginId, slug, manifest: manifest([], ['api.one.example']) });
      const two = factory.create({
        pluginId: 'plugin-2',
        slug: 'other-sink',
        manifest: manifest([], ['api.two.example']),
      });

      await one.http.fetch('https://api.one.example/', { method: 'GET', headers: {} });
      await two.http.fetch('https://api.two.example/', { method: 'GET', headers: {} });

      const [allowOne, allowTwo] = secureHttp.request.mock.calls.map(
        ([, options]) => (options as SafeHttpRequestOptions).allowHost as (hostname: string) => boolean,
      );
      expect([allowOne('api.one.example'), allowOne('api.two.example')]).toEqual([true, false]);
      expect([allowTwo('api.two.example'), allowTwo('api.one.example')]).toEqual([true, false]);
    });
  });

  describe('logger', () => {
    it('binds the plugin slug into the log context and maps info to log', () => {
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      try {
        const context = factory.create({ pluginId, slug, manifest: manifest([]) });

        context.logger.debug('d');
        context.logger.info('i');
        context.logger.warn('w');
        context.logger.error('e');

        expect(debugSpy).toHaveBeenCalledWith('d');
        expect(logSpy).toHaveBeenCalledWith('i');
        expect(warnSpy).toHaveBeenCalledWith('w');
        expect(errorSpy).toHaveBeenCalledWith('e');
      } finally {
        debugSpy.mockRestore();
        logSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
