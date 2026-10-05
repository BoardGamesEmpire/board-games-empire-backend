import { Injectable, Module, type INestMicroservice, type OnModuleInit } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { Writable } from 'node:stream';
import pino from 'pino';
import { bootstrapGrpcMicroservice } from './bootstrap-grpc-microservice';

const HOST_ENV = 'GATEWAY_HOST_SPEC_GRPC_HOST';
const PORT_ENV = 'GATEWAY_HOST_SPEC_GRPC_PORT';

const bootFailure = new Error('the token endpoint refused the connection');

/** Fails the way the IGDB gateway does when it cannot fetch its token: while the app initializes. */
@Injectable()
class FailsWhileInitializing implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    throw bootFailure;
  }
}

@Module({
  imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
  providers: [FailsWhileInitializing],
})
class FailingAppModule {}

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

describe('bootstrapGrpcMicroservice', () => {
  // Jest's copy of `process` shares the real exit code, so a test that sets it
  // would fail the run unless it is put back. Cleared for each test, so a code
  // left by anything earlier cannot pass for one the bootstrap set.
  let exitCodeBefore: typeof process.exitCode;
  let started: INestMicroservice | undefined;

  beforeEach(() => {
    exitCodeBefore = process.exitCode;
    process.exitCode = undefined;
    process.env[HOST_ENV] = '127.0.0.1';
    process.env[PORT_ENV] = '0';
  });

  afterEach(async () => {
    process.exitCode = exitCodeBefore;
    delete process.env[HOST_ENV];
    delete process.env[PORT_ENV];

    await started?.close();
    started = undefined;
  });

  describe('when the boot fails', () => {
    it('logs the error and sets exit code 1 before handing the error to the host', async () => {
      const { logger, records } = recordingLogger();

      let handedOff: HandOff | undefined;
      const onBootstrapError = jest.fn(() => {
        handedOff = { exitCode: process.exitCode, logged: [...records] };
      });

      await bootstrapGrpcMicroservice({
        appModule: FailingAppModule,
        displayName: 'spec service',
        hostEnv: HOST_ENV,
        portEnv: PORT_ENV,
        protoPackage: 'bge.spec.v1',
        protoDir: __dirname,
        bootstrapLogger: logger,
        registerShutdown: (app) => {
          started = app;
        },
        onBootstrapError,
      });

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
