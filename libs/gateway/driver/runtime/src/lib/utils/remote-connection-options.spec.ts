import { AuthType } from '@bge/database';
import { remoteConnectionOptions } from './remote-connection-options';

describe('remoteConnectionOptions', () => {
  const remote = {
    id: 'gw-1',
    connectionUrl: 'gateway.local',
    connectionPort: 50051,
    authType: AuthType.Bearer,
    authParameters: { token: 'secret' },
  };

  it("is how a remote DataGateway's row says to reach it", () => {
    expect(remoteConnectionOptions(remote)).toEqual({
      gatewayId: 'gw-1',
      connectionUrl: 'gateway.local',
      connectionPort: 50051,
      authType: AuthType.Bearer,
      authParameters: { token: 'secret' },
    });
  });

  it('leaves authParameters out for a row that stores none', () => {
    expect(remoteConnectionOptions({ ...remote, authParameters: null })).toEqual(
      expect.objectContaining({ authParameters: undefined }),
    );
  });

  // A plugin DataGateway's row has none of the three, and is never dialled
  // (#1083). A row missing any one of them can't be dialled either.
  it.each(['connectionUrl', 'connectionPort', 'authType'] as const)('is null for a row with no %s (#1083)', (field) => {
    expect(remoteConnectionOptions({ ...remote, [field]: null })).toBeNull();
  });
});
