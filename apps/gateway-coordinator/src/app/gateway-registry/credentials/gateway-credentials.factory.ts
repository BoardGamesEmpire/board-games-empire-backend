import { AuthType, Prisma } from '@bge/database';
import { ChannelCredentials, credentials } from '@grpc/grpc-js';
import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class GatewayCredentialsFactory {
  create(authType: AuthType, _authParameters?: Prisma.JsonValue): ChannelCredentials {
    switch (authType) {
      case AuthType.None: {
        return credentials.createInsecure();
      }

      case AuthType.ApiKey:
      case AuthType.Basic:
      case AuthType.Certificate:
      case AuthType.HMAC:
      case AuthType.JWT:
      case AuthType.OAuth:
      case AuthType.PSK:
        throw new NotImplementedException(
          `Auth type '${authType}' is not yet implemented. ` +
            `Gateway connection requires AuthType.None until this is implemented.`,
        );
    }
  }
}
