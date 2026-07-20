import { AuthType, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import { ChannelCredentials, credentials } from '@grpc/grpc-js';
import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class GatewayCredentialsFactory {
  create(authType: AuthType, _authParameters?: Prisma.JsonValue): ChannelCredentials {
    switch (authType) {
      case AuthType.None: {
        return credentials.createInsecure();
      }

      default: {
        throw new NotImplementedException(t('errors.gateway_registry.auth_type_not_implemented', { authType }));
      }
    }
  }
}
