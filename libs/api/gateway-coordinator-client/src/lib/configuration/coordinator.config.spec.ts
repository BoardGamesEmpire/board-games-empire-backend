import coordinatorClientConfig from './coordinator.config';

describe('where the api looks for the coordinator', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    delete process.env['GATEWAY_COORDINATOR_HOST'];
    delete process.env['GATEWAY_COORDINATOR_PORT'];
  });

  afterEach(() => {
    process.env = original;
  });

  // `0.0.0.0` reaches a local server on some systems, but it is an address to
  // listen on, not one to dial.
  it.each(['development', 'production'])('is this machine by default, under NODE_ENV %s', (nodeEnv) => {
    process.env['NODE_ENV'] = nodeEnv;

    expect(coordinatorClientConfig().host).toBe('localhost');
  });

  it('is the host the environment sets', () => {
    process.env['GATEWAY_COORDINATOR_HOST'] = 'coordinator';

    expect(coordinatorClientConfig().host).toBe('coordinator');
  });

  it('is the default when the environment sets the address empty', () => {
    Object.assign(process.env, { GATEWAY_COORDINATOR_HOST: '', GATEWAY_COORDINATOR_PORT: '', NODE_ENV: 'production' });

    expect(coordinatorClientConfig()).toEqual({ host: 'localhost', port: 50051 });
  });

  // The api's schema reads `5e4` as 50000. Read any other way, the api would
  // dial a port the schema never checked.
  it('reads a port in exponent form as the schema does', () => {
    process.env['GATEWAY_COORDINATOR_PORT'] = '5e4';

    expect(coordinatorClientConfig().port).toBe(50000);
  });
});
