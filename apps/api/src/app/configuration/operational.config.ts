import { env } from '@bge/env';
import { parseCidr } from '@bge/secure-http';
import { registerAs } from '@nestjs/config';
import Joi from 'joi';
import { DEFAULT_OPERATIONAL_SOURCES } from '../lib/operational-sources';

export interface OperationalConfig {
  /** The second listener's port, which serves `/health`, `/metrics` and the API document. */
  port: number;

  /** CIDR ranges that may reach that port. Naming any replaces the default list. */
  sources: string[];
}

/** What `OPERATIONAL_PORT` falls back to, which the root schema compares when it is unset. */
export const DEFAULT_OPERATIONAL_PORT = 33334;

const splitList = (value: string): string[] => value.split(',').map((entry) => entry.trim());

/** An address, a slash, and a prefix of one to three digits and nothing else. */
const CIDR_SHAPE = /^[^/]+\/\d{1,3}$/;

/**
 * The operational port and the networks that may reach it (#1511). Both
 * defaults are applied here and not in the Joi schema: a Joi default is written
 * into the environment ahead of the config and overrides it (#626). The port's
 * is defined below; the sources' is `DEFAULT_OPERATIONAL_SOURCES`, beside the
 * rule that reads them (`lib/operational-sources.ts`).
 */
export default registerAs('operational', () =>
  env.provideMany<OperationalConfig>([
    {
      keyTo: 'port',
      key: 'OPERATIONAL_PORT',
      defaultValue: DEFAULT_OPERATIONAL_PORT,
      // `Number`, as Joi converts it: `parseInt` reads `1e3` as 1, so the root
      // schema's collision check would compare a port the listener never binds.
      mutators: [(value: string) => Number(value)],
    },
    {
      keyTo: 'sources',
      key: 'OPERATIONAL_SOURCES',
      defaultValue: DEFAULT_OPERATIONAL_SOURCES.join(','),
      mutators: [splitList],
    },
  ]),
);

/**
 * `OPERATIONAL_SOURCES` is checked entry by entry: `parseCidrList` skips an
 * entry it can't read, so a typo would narrow the rule without a word, and a
 * bare address is refused as `parseCidr` refuses it, for want of a prefix.
 * Both variables accept `''`, which `@bge/env` reads as unset.
 *
 * `parseCidr` reads the prefix with `parseInt`, so `/8x` would pass as /8 and
 * `/2 4` as /2, silently widening the range (#1511); the prefix must be digits.
 */
export const operationalConfigValidationSchema = {
  OPERATIONAL_PORT: Joi.number().port().allow(''),
  OPERATIONAL_SOURCES: Joi.string()
    .custom((value: string, helpers) => {
      const unreadable = splitList(value).filter((entry) => !CIDR_SHAPE.test(entry) || parseCidr(entry) === null);

      // The entries go in as context, not into the template, so a `{` in one stays text.
      return unreadable.length === 0
        ? value
        : helpers.message(
            {
              custom:
                '{{#label}} must be a comma-separated list of CIDR ranges such as 10.0.0.0/8. These entries are not: {{#entries}}',
            },
            { entries: unreadable.map((entry) => `"${entry}"`).join(', ') },
          );
    })
    .allow(''),
};
