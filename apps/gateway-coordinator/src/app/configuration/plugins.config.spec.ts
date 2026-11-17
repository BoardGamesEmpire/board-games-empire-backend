import { configurationValidationSchema } from './index';
import pluginsConfig from './plugins.config';

// The coordinator loads the data-gateway plugins the api installs, so it must
// read the same root the api writes them to (#1083). The api's defaults, from
// `apps/api/src/app/configuration/plugins.config.ts`.
describe("the coordinator's plugins root", () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
    delete process.env['PLUGINS_ROOT'];
  });

  afterEach(() => {
    process.env = original;
  });

  it.each([
    ['production', '/var/lib/bge/plugins'],
    ['development', './data/plugins'],
  ])("defaults, under NODE_ENV %s, to the api's: %s (#1083)", (nodeEnv, root) => {
    process.env['NODE_ENV'] = nodeEnv;

    expect(pluginsConfig().pluginsRoot).toBe(root);
  });

  it('is read from PLUGINS_ROOT (#1083)', () => {
    process.env['PLUGINS_ROOT'] = '/srv/bge/plugins';

    expect(pluginsConfig().pluginsRoot).toBe('/srv/bge/plugins');
  });

  // `.env.example` ships it empty, and `@bge/env` reads an empty variable as
  // unset, so the schema lets it through and the config defaults it.
  it('is defaulted when set empty, as when unset (#1083)', () => {
    const { error } = configurationValidationSchema.validate({ PLUGINS_ROOT: '' }, { allowUnknown: true });
    Object.assign(process.env, { PLUGINS_ROOT: '', NODE_ENV: 'production' });

    expect(error).toBeUndefined();
    expect(pluginsConfig().pluginsRoot).toBe('/var/lib/bge/plugins');
  });
});
