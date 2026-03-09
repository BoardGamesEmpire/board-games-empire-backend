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

      default: {
        throw new NotImplementedException(
          `Auth type '${authType}' is not yet implemented. ` +
            `Gateway connection requires AuthType.None until this is implemented.`,
        );
      }
    }
  }
}
