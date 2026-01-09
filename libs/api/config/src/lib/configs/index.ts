import auth, { authConfigValidationSchema } from './auth.config';
import database, { databaseConfigValidationSchema } from './database.config';
import graphql, { graphqlConfigValidationSchema } from './graphql.config';
import health, { healthConfigValidationSchema } from './health.config';
import jwt, { jwtConfigValidationSchema } from './jwt.config';
import prometheus from './prometheus.config';
import rabbit from './rabbitmq.config';
import security, { securityConfigValidationSchema } from './security.config';
import server, { serverConfigValidationSchema } from './server.config';
import swagger, { swaggerConfigValidationSchema } from './swagger.config';
import throttle, { throttleConfigValidationSchema } from './throttle.config';

export const configuration = [
  auth,
  database,
  graphql,
  health,
  jwt,
  prometheus,
  rabbit,
  security,
  server,
  swagger,
  throttle,
];

export const configurationValidationSchema = {
  ...authConfigValidationSchema,
  ...databaseConfigValidationSchema,
  ...graphqlConfigValidationSchema,
  ...healthConfigValidationSchema,
  ...jwtConfigValidationSchema,
  ...securityConfigValidationSchema,
  ...serverConfigValidationSchema,
  ...swaggerConfigValidationSchema,
  ...throttleConfigValidationSchema,
};

export { env } from './env';
