import * as proto from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { firstValueFrom } from 'rxjs';
import { InMemoryGatewayDriver } from './in-memory-gateway.driver.js';
import { runDataGatewayDriverContract } from './run-data-gateway-driver-contract.js';

const knownGame = { externalId: 'bgg-13', name: 'Catan' } as unknown as proto.GameData;
const searchHit = { externalId: 'bgg-13', name: 'Catan' } as unknown as proto.GameSearchData;

runDataGatewayDriverContract('InMemoryGatewayDriver', () => ({
  driver: new InMemoryGatewayDriver({
    games: [knownGame],
    searchResults: [searchHit],
    expansionsByBaseExternalId: { 'bgg-13': [searchHit] },
    languages: [{ value: 'en-US', format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47 }],
  }),
  capabilities: [
    proto.Capability.CAPABILITY_SEARCH,
    proto.Capability.CAPABILITY_FETCH,
    proto.Capability.CAPABILITY_FETCH_EXPANSIONS,
    proto.Capability.CAPABILITY_LIST_LANGUAGES,
  ],
  knownExternalId: 'bgg-13',
  unknownExternalId: 'no-such-id',
  searchQuery: 'catan',
}));

// Every operation but fetch answers UNIMPLEMENTED here, so this passes only
// if the suite leaves out the operations a driver doesn't declare.
runDataGatewayDriverContract('InMemoryGatewayDriver declaring only fetch', () => ({
  driver: new InMemoryGatewayDriver({ games: [knownGame], capabilities: [proto.Capability.CAPABILITY_FETCH] }),
  capabilities: [proto.Capability.CAPABILITY_FETCH],
  knownExternalId: 'bgg-13',
  unknownExternalId: 'no-such-id',
  searchQuery: 'catan',
}));

describe('InMemoryGatewayDriver capabilities', () => {
  it('declares the operations it is given', async () => {
    const driver = new InMemoryGatewayDriver({ capabilities: [proto.Capability.CAPABILITY_FETCH] });

    await expect(firstValueFrom(driver.describe({}))).resolves.toMatchObject({
      capabilities: [proto.Capability.CAPABILITY_FETCH],
    });
  });

  it('answers an operation it does not declare with UNIMPLEMENTED, and serves the ones it does', async () => {
    const driver = new InMemoryGatewayDriver({
      games: [knownGame],
      searchResults: [searchHit],
      capabilities: [proto.Capability.CAPABILITY_FETCH],
    });

    await expect(firstValueFrom(driver.searchGames({ correlationId: 'x', query: 'catan' }))).rejects.toMatchObject({
      code: status.UNIMPLEMENTED,
    });
    await expect(
      firstValueFrom(driver.fetchExpansions({ correlationId: 'x', baseExternalId: 'bgg-13' })),
    ).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
    await expect(firstValueFrom(driver.listLanguages({ correlationId: 'x' }))).rejects.toMatchObject({
      code: status.UNIMPLEMENTED,
    });
    await expect(firstValueFrom(driver.fetchGame({ correlationId: 'x', externalId: 'bgg-13' }))).resolves.toMatchObject(
      { game: knownGame },
    );
  });
});

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

  it('errors describe after failWith too', async () => {
    const driver = new InMemoryGatewayDriver();

    driver.failWith(new Error('boom'));

    await expect(firstValueFrom(driver.describe({}))).rejects.toThrow('boom');
  });

  it('answers an operation it does not declare with the injected failure, not UNIMPLEMENTED', async () => {
    // A DataGateway that can't be reached can't say what it doesn't implement.
    const driver = new InMemoryGatewayDriver({ capabilities: [proto.Capability.CAPABILITY_FETCH] });

    driver.failWith(new Error('boom'));

    await expect(firstValueFrom(driver.searchGames({ correlationId: 'x', query: 'catan' }))).rejects.toThrow('boom');
  });

  it('tracks disposal', () => {
    const driver = new InMemoryGatewayDriver();

    expect(driver.disposed).toBe(false);
    driver.dispose();
    driver.dispose();
    expect(driver.disposed).toBe(true);
  });
});
