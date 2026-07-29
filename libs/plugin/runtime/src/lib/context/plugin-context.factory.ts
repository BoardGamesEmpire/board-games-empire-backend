import { AuditContextService } from '@bge/actor-context';
import type {
  PluginActorAccessor,
  PluginActorView,
  PluginConfigAccessor,
  PluginContext,
  PluginEventPublisher,
  PluginLogger,
} from '@boardgamesempire/plugin-contract';
import type { PluginManifest } from '@boardgamesempire/plugin-manifest';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PluginConfigService } from '../config/plugin-config.service';
import { PluginEmitNotDeclaredError } from '../loader/loader.errors';
import { toPluginActorView } from './plugin-actor-view.projection';

export interface PluginContextInput {
  readonly pluginId: string;
  readonly slug: string;
  readonly manifest: PluginManifest;
}

/**
 * Builds the per-plugin capability surface (#59). One context per loaded
 * plugin, constructed at load time and closed over the plugin's identity —
 * a plugin cannot reach another plugin's config or emit under another
 * plugin's namespace because the closures simply never carry foreign
 * identity.
 */
@Injectable()
export class PluginContextFactory {
  constructor(
    private readonly emitter: EventEmitter2,
    private readonly configService: PluginConfigService,
    private readonly auditContext: AuditContextService,
  ) {}

  create(input: PluginContextInput): PluginContext {
    return {
      pluginId: input.pluginId,
      slug: input.slug,
      logger: this.buildLogger(input.slug),
      config: this.buildConfigAccessor(input.slug),
      events: this.buildEventPublisher(input.slug, input.manifest),
      actor: this.buildActorAccessor(),
    };
  }

  private buildLogger(slug: string): PluginLogger {
    const logger = new Logger(`plugin:${slug}`);

    return {
      debug: (message: string): void => logger.debug(message),
      info: (message: string): void => logger.log(message),
      warn: (message: string): void => logger.warn(message),
      error: (message: string): void => logger.error(message),
    };
  }

  private buildConfigAccessor(slug: string): PluginConfigAccessor {
    return {
      current: (): Readonly<Record<string, unknown>> => this.configService.snapshotFor(slug),
    };
  }

  private buildEventPublisher(slug: string, manifest: PluginManifest): PluginEventPublisher {
    // Copied into a Set at construction: the allowlist is fixed for the
    // lifetime of the loaded version, and a later mutation of the manifest
    // object must not widen what the plugin may emit.
    const declaredEmits: ReadonlySet<string> = new Set(manifest.events.emits);

    return {
      emit: (eventName: string, payload: unknown): void => {
        if (!declaredEmits.has(eventName)) {
          throw new PluginEmitNotDeclaredError(slug, eventName);
        }

        this.emitter.emit(eventName, payload);
      },
    };
  }

  private buildActorAccessor(): PluginActorAccessor {
    return {
      // Projected, never the live CLS object — see plugin-actor-view.projection.ts.
      current: (): PluginActorView | null => toPluginActorView(this.auditContext.getActor()),
    };
  }
}
