import { env } from '@bge/env';
import {
  ConsoleLogger,
  Injectable,
  Logger,
  Module,
  type INestMicroservice,
  type OnModuleInit,
  type Type,
} from '@nestjs/common';
import { ConfigModule, registerAs } from '@nestjs/config';
import Joi from 'joi';
import { LoggerModule } from 'nestjs-pino';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import {
  bootstrapGrpcMicroservice,
  type GrpcListenAddress,
  type GrpcMicroserviceBootstrapConfig,
} from './bootstrap-grpc-microservice';

const HOST_ENV = 'GATEWAY_HOST_SPEC_GRPC_HOST';
const PORT_ENV = 'GATEWAY_HOST_SPEC_GRPC_PORT';
const CREDENTIAL_ENV = 'GATEWAY_HOST_SPEC_CREDENTIAL';

const PROTO_PACKAGE = 'bge.spec.v1';
const PROTO = `syntax = "proto3";
package ${PROTO_PACKAGE};
service SpecService { rpc Ping (PingRequest) returns (PingReply); }
message PingRequest {}
message PingReply {}
`;

/** The port {@link defaultedAddress} falls back to, picked free for each test. */
let defaultPort = 0;

/** An address config as the apps declare theirs: read from the environment, with defaults. */
const defaultedAddress = registerAs('defaultedAddress', () =>
  env.provideMany<GrpcListenAddress>([
    { key: HOST_ENV, keyTo: 'host', defaultValue: '127.0.0.1' },
    { key: PORT_ENV, keyTo: 'port', defaultValue: defaultPort, mutators: parseInt },
  ]),
);

/** An address config with no defaults, so reading it with nothing set throws, naming {@link HOST_ENV}. */
const requiredAddress = registerAs('requiredAddress', () =>
  env.provideMany<GrpcListenAddress>([
    { key: HOST_ENV, keyTo: 'host' },
    { key: PORT_ENV, keyTo: 'port', mutators: parseInt },
  ]),
);

const silentLogger = LoggerModule.forRoot({ pinoHttp: { level: 'silent' } });

@Module({
  imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [defaultedAddress] }), silentLogger],
})
class ServingAppModule {}

const bootFailure = new Error('the token endpoint refused the connection');

/** Fails the way the IGDB gateway does when it cannot fetch its token: while the app initializes. */
@Injectable()
class FailsWhileInitializing implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    throw bootFailure;
  }
}

@Module({
  imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [defaultedAddress] }), silentLogger],
  providers: [FailsWhileInitializing],
})
class FailingAppModule {}

/**
 * An app whose root config rejects its environment, as a gateway's does when
 * its credential is missing. Built when called: `forRoot` validates at once,
 * and its rejection must reach the bootstrap before Node reports it unhandled.
 */
function appWithInvalidConfig(): Type<unknown> {
  @Module({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [requiredAddress],
        validationSchema: Joi.object({ [CREDENTIAL_ENV]: Joi.string().required() }),
      }),
      silentLogger,
    ],
  })
  class InvalidConfigAppModule {}

  return InvalidConfigAppModule;
}

interface LogRecord {
  readonly msg: string;
  readonly err?: { readonly message: string };
}

/** A real pino logger whose records are kept in memory, in the order they were written. */
function recordingLogger(): { readonly logger: pino.Logger; readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      records.push(JSON.parse(chunk.toString('utf8')) as LogRecord);
      done();
    },
  });

  return { logger: pino({ level: 'debug' }, sink), records };
}

/** What the host's failure handler could see at the moment it was called. */
interface HandOff {
  readonly exitCode: typeof process.exitCode;
  readonly logged: readonly LogRecord[];
}

/** An OS-assigned port, released for the server to bind. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Resolves once a TCP connection to `host:port` opens. */
function connects(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve();
    });
    socket.on('error', reject);
  });
}

describe('bootstrapGrpcMicroservice', () => {
  let protoDir: string;

  // Jest's copy of `process` shares the real exit code, so a test that sets it
  // would fail the run unless it is put back. Cleared for each test, so a code
  // left by anything earlier cannot pass for one the bootstrap set.
  let exitCodeBefore: typeof process.exitCode;
  let started: INestMicroservice | undefined;

  const bootstrap = (overrides: Partial<GrpcMicroserviceBootstrapConfig>): Promise<void> =>
    bootstrapGrpcMicroservice({
      appModule: ServingAppModule,
      displayName: 'spec service',
      addressConfig: defaultedAddress,
      protoPackage: PROTO_PACKAGE,
      protoDir,
      bootstrapLogger: recordingLogger().logger,
      registerShutdown: (app) => {
        started = app;
      },
      onBootstrapError: () => undefined,
      ...overrides,
    });

  beforeAll(() => {
    protoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-gateway-host-'));
    fs.writeFileSync(path.join(protoDir, 'spec.proto'), PROTO);
  });

  afterAll(() => {
    fs.rmSync(protoDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    exitCodeBefore = process.exitCode;
    process.exitCode = undefined;
    // A boot leaves Nest's logger as its app's silent one, and nothing puts it
    // back. Each test starts from the logger a fresh process has instead, so
    // none depends on what ran before it.
    Logger.overrideLogger(new ConsoleLogger());
    defaultPort = await freePort();
  });

  afterEach(async () => {
    process.exitCode = exitCodeBefore;
    delete process.env[HOST_ENV];
    jest.restoreAllMocks();

    await started?.close();
    started = undefined;
  });

  it('listens on the address its config resolves, defaults included', async () => {
    const onBootstrapError = jest.fn();

    await bootstrap({ onBootstrapError });

    expect(onBootstrapError).not.toHaveBeenCalled();
    await expect(connects('127.0.0.1', defaultPort)).resolves.toBeUndefined();
  });

  it('listens on an IPv6 address its config resolves', async () => {
    process.env[HOST_ENV] = '::1';
    const onBootstrapError = jest.fn();

    await bootstrap({ onBootstrapError });

    expect(onBootstrapError).not.toHaveBeenCalled();
    await expect(connects('::1', defaultPort)).resolves.toBeUndefined();
  });

  describe('when the config fails validation', () => {
    it('lets Nest name the variable that failed, before anything reads the address', async () => {
      // Nest prints the failure, then exits the process. Thrown here instead,
      // so the boot stops where it would have. Nest aborts when that exit
      // throws, so the abort throws too.
      const stopped = (): never => {
        throw new Error('the process would have ended here');
      };
      const exit = jest.spyOn(process, 'exit').mockImplementation(stopped);
      jest.spyOn(process, 'abort').mockImplementation(stopped);
      const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      const { logger, records } = recordingLogger();

      await bootstrap({ appModule: appWithInvalidConfig(), addressConfig: requiredAddress, bootstrapLogger: logger });

      const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      stderr.mockRestore();
      stdout.mockRestore();

      expect(exit).toHaveBeenCalledWith(1);
      expect(printed).toContain(`"${CREDENTIAL_ENV}" is required`);
      // Neither Nest's output nor the bootstrap's own log names the address.
      expect(printed + JSON.stringify(records)).not.toContain(HOST_ENV);
    });
  });

  describe('when the boot fails', () => {
    it('logs the error and sets exit code 1 before handing the error to the host', async () => {
      const { logger, records } = recordingLogger();

      let handedOff: HandOff | undefined;
      const onBootstrapError = jest.fn(() => {
        handedOff = { exitCode: process.exitCode, logged: [...records] };
      });

      await bootstrap({ appModule: FailingAppModule, bootstrapLogger: logger, onBootstrapError });

      expect(onBootstrapError).toHaveBeenCalledTimes(1);
      expect(onBootstrapError).toHaveBeenCalledWith(bootFailure);

      // What the handler is promised: the error is already logged and the exit
      // code is already 1 when it is called.
      expect(handedOff).toEqual({
        exitCode: 1,
        logged: expect.arrayContaining([
          expect.objectContaining({
            msg: 'bootstrap failed',
            err: expect.objectContaining({ message: bootFailure.message }),
          }),
        ]),
      });

      // The handler may never finish (#630). The process then ends on its own,
      // with the code the bootstrap leaves once it returns.
      expect(process.exitCode).toBe(1);
    });
  });
});
