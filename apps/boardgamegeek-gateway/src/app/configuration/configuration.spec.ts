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

  it('adds no gRPC address of its own when the environment sets none', () => {
    // ConfigModule copies each validated value into process.env when the
    // variable is unset, so a default here would override the gateway
    // config's per-environment ones (production binds 50051).
    const { value } = validate({ BOARDGAMEGEEK_API_KEY: 'test-api-key' });

    expect(value).toEqual({ BOARDGAMEGEEK_API_KEY: 'test-api-key' });
  });
});
