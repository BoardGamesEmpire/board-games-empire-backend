import { AuthType } from '@bge/database';
import { hashGatewayConfig } from './hash-config';

describe('hashGatewayConfig', () => {
  // Each field hashes as its text, and a missing one as nothing, so a row
  // with no connection fields is three empty fields and no auth parameters.
  it("hashes a plugin DataGateway's row, which has no connection fields, to a value no remote row has (#1083)", () => {
    const pluginRow = { connectionUrl: null, connectionPort: null, authType: null, authParameters: null };
    const remoteRow = { connectionUrl: 'gateway.example', connectionPort: 50051, authType: AuthType.None };

    expect(hashGatewayConfig(pluginRow)).toBe('|||{}');
    expect(hashGatewayConfig(remoteRow)).toBe('gateway.example|50051|None|{}');
  });
});
