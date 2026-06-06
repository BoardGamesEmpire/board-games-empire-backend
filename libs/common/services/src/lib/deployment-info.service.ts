import { DeploymentRuntime } from '@bge/database';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Boot-time detection of the runtime environment hosting this server.
 *
 * Signal probes are injected so tests can supply deterministic
 * fixtures rather than mucking with the filesystem.
 *
 * Detection is best-effort. When signals are ambiguous (e.g. K8s pod that
 * also has `/.dockerenv`), the most specific verdict wins via probe order:
 * Kubernetes → DockerCompose → Docker → Serverless → StandaloneNode.
 */

export interface DeploymentInfo {
  readonly runtime: DeploymentRuntime;
  readonly version: string | null;
}

/** Injection token for the detection probe (overridden in tests). */
export const DEPLOYMENT_SIGNALS = Symbol('DEPLOYMENT_SIGNALS');

export interface DeploymentSignals {
  readonly env: NodeJS.ProcessEnv;
  hasFile(path: string): boolean;
  readFileSafe(path: string): string;
}

export const ProcessDeploymentSignals: DeploymentSignals = {
  env: process.env,
  hasFile: (path: string): boolean => existsSync(path),
  readFileSafe: (path: string): string => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  },
};

@Injectable()
export class DeploymentInfoService implements OnModuleInit {
  private info: DeploymentInfo | null = null;

  constructor(@Inject(DEPLOYMENT_SIGNALS) private readonly signals: DeploymentSignals) {}

  onModuleInit(): void {
    this.info = this.detect();
  }

  getInfo(): DeploymentInfo {
    if (this.info === null) {
      // Cover the unusual case where someone reaches in before lifecycle.
      this.info = this.detect();
    }

    return this.info;
  }

  /** Exposed for tests; not part of the public surface. */
  detect(): DeploymentInfo {
    const runtime = this.detectRuntime();
    const version = this.signals.env['BGE_VERSION'] ?? null;

    return { runtime, version };
  }

  private detectRuntime(): DeploymentRuntime {
    const { env } = this.signals;

    // K8s wins outright — pods also have /.dockerenv, so test this first.
    if (env['KUBERNETES_SERVICE_HOST']) {
      return DeploymentRuntime.Kubernetes;
    }

    // Compose advertises itself via labels and well-known env vars.
    const inDocker = this.signals.hasFile('/.dockerenv') || /docker|containerd/.test(this.readCgroup());

    if (env['COMPOSE_PROJECT_NAME'] || env['COMPOSE_SERVICE'] || (inDocker && env['compose_service'])) {
      return DeploymentRuntime.DockerCompose;
    }

    if (inDocker) {
      return DeploymentRuntime.Docker;
    }

    // Common serverless host indicators.
    if (env['AWS_LAMBDA_FUNCTION_NAME'] || env['K_SERVICE'] || env['FLY_APP_NAME'] || env['VERCEL']) {
      return DeploymentRuntime.Serverless;
    }

    if (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32') {
      return DeploymentRuntime.StandaloneNode;
    }

    return DeploymentRuntime.Unknown;
  }

  private readCgroup(): string {
    return this.signals.readFileSafe('/proc/1/cgroup');
  }
}
