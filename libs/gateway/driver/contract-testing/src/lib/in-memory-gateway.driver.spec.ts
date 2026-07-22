import * as proto from '@boardgamesempire/proto-gateway';
import { firstValueFrom } from 'rxjs';
import { InMemoryGatewayDriver } from './in-memory-gateway.driver.js';
import { runGameGatewayDriverContract } from './run-game-gateway-driver-contract.js';

const knownGame = { externalId: 'bgg-13', name: 'Catan' } as unknown as proto.GameData;
const searchHit = { externalId: 'bgg-13', name: 'Catan' } as unknown as proto.GameSearchData;

runGameGatewayDriverContract('InMemoryGatewayDriver', () => ({
  driver: new InMemoryGatewayDriver({
    games: [knownGame],
    searchResults: [searchHit],
    expansionsByBaseExternalId: { 'bgg-13': [searchHit] },
    languages: [{ value: 'en-US', format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47 }],
  }),
  knownExternalId: 'bgg-13',
  unknownExternalId: 'no-such-id',
  searchQuery: 'catan',
}));

describe('InMemoryGatewayDriver failure injection', () => {
  it('errors every RPC after failWith and recovers after restore', async () => {
    const driver = new InMemoryGatewayDriver({ games: [knownGame] });

    driver.failWith(new Error('boom'));
    await expect(firstValueFrom(driver.fetchGame({ correlationId: 'x', externalId: 'bgg-13' }))).rejects.toThrow(
      'boom',
    );

    driver.restore();
    const response = await firstValueFrom(driver.fetchGame({ correlationId: 'x', externalId: 'bgg-13' }));
    expect(response.game?.externalId).toBe('bgg-13');
  });

  it('tracks disposal', () => {
    const driver = new InMemoryGatewayDriver();

    expect(driver.disposed).toBe(false);
    driver.dispose();
    driver.dispose();
    expect(driver.disposed).toBe(true);
  });
});
