import { configurationValidationSchema } from './index';

/**
 * Validates as `ConfigModule.forRoot` does: a key the schema does not name
 * passes through untouched. So a rule written against the wrong key name
 * never fails; it never runs at all.
 */
const validate = (environment: Record<string, string>) =>
  configurationValidationSchema.validate(environment, { allowUnknown: true });

const BOOTABLE = {
  BOARDGAMEGEEK_API_KEY: 'test-api-key',
  BOARDGAMEGEEK_GATEWAY_GRPC_HOST: 'localhost',
  BOARDGAMEGEEK_GATEWAY_GRPC_PORT: '50053',
};

describe('the BoardGameGeek gateway configuration schema', () => {
  it('accepts the gRPC host and port the gateway binds to', () => {
    expect(validate(BOOTABLE).error).toBeUndefined();
  });

  it('rejects a gRPC port that is not a number', () => {
    const { error } = validate({ ...BOOTABLE, BOARDGAMEGEEK_GATEWAY_GRPC_PORT: 'fifty' });

    expect(error?.message).toMatch(/BOARDGAMEGEEK_GATEWAY_GRPC_PORT/);
  });

  it('rejects a gRPC host that is neither a hostname nor an IP address', () => {
    const { error } = validate({ ...BOOTABLE, BOARDGAMEGEEK_GATEWAY_GRPC_HOST: 'not a host' });

    expect(error?.message).toMatch(/BOARDGAMEGEEK_GATEWAY_GRPC_HOST/);
  });

  // ConfigModule copies these defaults into process.env, where the bootstrap
  // reads the address the gateway listens on.
  it.each([
    [undefined, 50053],
    ['development', 50053],
    ['test', 50053],
    ['production', 50051],
  ])('defaults the gRPC address for NODE_ENV %s to 0.0.0.0:%i', (nodeEnv, port) => {
    const apiKey = { BOARDGAMEGEEK_API_KEY: 'test-api-key' };
    const { value } = validate(nodeEnv ? { ...apiKey, NODE_ENV: nodeEnv } : apiKey);

    expect(value).toMatchObject({ BOARDGAMEGEEK_GATEWAY_GRPC_HOST: '0.0.0.0', BOARDGAMEGEEK_GATEWAY_GRPC_PORT: port });
  });

  it('keeps the gRPC address the environment sets, in production too', () => {
    const { value } = validate({ ...BOOTABLE, NODE_ENV: 'production' });

    expect(value).toMatchObject({
      BOARDGAMEGEEK_GATEWAY_GRPC_HOST: 'localhost',
      BOARDGAMEGEEK_GATEWAY_GRPC_PORT: 50053,
    });
  });
});
