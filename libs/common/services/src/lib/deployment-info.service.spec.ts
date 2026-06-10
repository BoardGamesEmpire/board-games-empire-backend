import { DeploymentRuntime } from '@bge/database';
import { Test, TestingModule } from '@nestjs/testing';
import { DEPLOYMENT_SIGNALS, DeploymentInfoService, type DeploymentSignals } from './deployment-info.service';

/**
 * Pure-signal detection — every test injects a deterministic `DeploymentSignals`
 * probe so we never touch the real filesystem or `process.env`.
 */

interface SignalsOverrides {
  env?: NodeJS.ProcessEnv;
  files?: ReadonlySet<string>;
  cgroup?: string;
}

function makeSignals({ env = {}, files = new Set(), cgroup = '' }: SignalsOverrides = {}): DeploymentSignals {
  return {
    env,
    hasFile: (path: string): boolean => files.has(path),
    readFileSafe: (path: string): string => (path === '/proc/1/cgroup' ? cgroup : ''),
  };
}

async function buildService(signals: DeploymentSignals): Promise<DeploymentInfoService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [DeploymentInfoService, { provide: DEPLOYMENT_SIGNALS, useValue: signals }],
  }).compile();

  const service = module.get(DeploymentInfoService);

  service.onModuleInit();

  return service;
}

describe('DeploymentInfoService', () => {
  describe('runtime detection', () => {
    it('detects Kubernetes via KUBERNETES_SERVICE_HOST', async () => {
      const service = await buildService(
        makeSignals({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, files: new Set(['/.dockerenv']) }),
      );

      expect(service.getInfo().runtime).toBe(DeploymentRuntime.Kubernetes);
    });

    it('prefers Kubernetes over Docker when both signals are present', async () => {
      const service = await buildService(
        makeSignals({
          env: { KUBERNETES_SERVICE_HOST: '10.0.0.1', COMPOSE_PROJECT_NAME: 'spurious' },
          files: new Set(['/.dockerenv']),
          cgroup: 'docker/abc',
        }),
      );

      expect(service.getInfo().runtime).toBe(DeploymentRuntime.Kubernetes);
    });

    it('detects DockerCompose via COMPOSE_PROJECT_NAME', async () => {
      const service = await buildService(
        makeSignals({ env: { COMPOSE_PROJECT_NAME: 'bge' }, files: new Set(['/.dockerenv']) }),
      );

      expect(service.getInfo().runtime).toBe(DeploymentRuntime.DockerCompose);
    });

    it('detects Docker via /.dockerenv with no compose signals', async () => {
      const service = await buildService(makeSignals({ files: new Set(['/.dockerenv']) }));

      expect(service.getInfo().runtime).toBe(DeploymentRuntime.Docker);
    });

    it('detects Docker via cgroup contents when /.dockerenv is absent', async () => {
      const service = await buildService(makeSignals({ cgroup: '0::/docker/abc123' }));

      expect(service.getInfo().runtime).toBe(DeploymentRuntime.Docker);
    });

    it('detects Serverless via AWS_LAMBDA_FUNCTION_NAME', async () => {
      const service = await buildService(makeSignals({ env: { AWS_LAMBDA_FUNCTION_NAME: 'bge-api' } }));

      expect(service.getInfo().runtime).toBe(DeploymentRuntime.Serverless);
    });

    it('detects Serverless via Cloud Run K_SERVICE', async () => {
      const service = await buildService(makeSignals({ env: { K_SERVICE: 'bge-api' } }));

      expect(service.getInfo().runtime).toBe(DeploymentRuntime.Serverless);
    });

    it('falls back to StandaloneNode when no container signals are present', async () => {
      const service = await buildService(makeSignals());

      expect(service.getInfo().runtime).toBe(DeploymentRuntime.StandaloneNode);
    });
  });

  describe('version detection', () => {
    it('reads BGE_VERSION from the environment when set', async () => {
      const service = await buildService(makeSignals({ env: { BGE_VERSION: '0.4.1+abc123' } }));

      expect(service.getInfo().version).toBe('0.4.1+abc123');
    });

    it('reports null version when BGE_VERSION is unset', async () => {
      const service = await buildService(makeSignals());

      expect(service.getInfo().version).toBeNull();
    });
  });

  describe('caching behavior', () => {
    it('caches detection on module init and returns the same info thereafter', async () => {
      const signals = makeSignals({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } });
      const service = await buildService(signals);

      const first = service.getInfo();
      const second = service.getInfo();

      expect(second).toBe(first);
    });
  });
});
