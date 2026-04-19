import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { SearchQueryDto } from './dto/search-query.dto';
import type { SearchResponseDto } from './dto/search-response.dto';
import { GameSearchController } from './game-search.controller';
import { GameSearchService } from './game-search.service';

describe('GameSearchController', () => {
  let controller: GameSearchController;
  let searchService: jest.Mocked<GameSearchService>;

  const mockSearchService = {
    search: jest.fn(),
  } satisfies Partial<jest.Mocked<GameSearchService>>;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      controllers: [GameSearchController],
      overrideGuards: [PoliciesGuard],
      providers: [{ provide: GameSearchService, useValue: mockSearchService }],
    });

    controller = module.get(GameSearchController);
    searchService = module.get(GameSearchService);
  });

  afterEach(() => jest.clearAllMocks());

  const makeDto = (overrides?: Partial<SearchQueryDto>): SearchQueryDto => ({
    query: 'Gloomhaven',
    gatewayIds: ['igdb-gw-1'],
    includeLocal: true,
    includeExternal: true,
    ...overrides,
  });

  const makeResponse = (overrides?: Partial<SearchResponseDto>): SearchResponseDto => ({
    correlationId: 'corr-1',
    resultsBySource: {},
    ...overrides,
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates to GameSearchService.search with the query DTO', async () => {
    const dto = makeDto();
    const response = makeResponse();
    searchService.search.mockReturnValue(of(response));

    await firstValueFrom(controller.search(dto));

    expect(searchService.search).toHaveBeenCalledWith(dto);
    expect(searchService.search).toHaveBeenCalledTimes(1);
  });

  it('returns the SearchResponseDto from the service', async () => {
    const dto = makeDto();
    const response = makeResponse({
      resultsBySource: {
        'igdb-gw-1': [
          {
            externalId: '174430',
            title: 'Gloomhaven',
            contentType: 'CONTENT_TYPE_BASE_GAME',
            inSystem: false,
            platforms: [],
            availableReleases: [],
          },
        ],
      },
    });
    searchService.search.mockReturnValue(of(response));

    const result = await firstValueFrom(controller.search(dto));

    expect(result.correlationId).toBe('corr-1');
    expect(result.resultsBySource['igdb-gw-1']).toHaveLength(1);
    expect(result.resultsBySource['igdb-gw-1'][0].title).toBe('Gloomhaven');
  });

  it('propagates service errors to the caller', async () => {
    searchService.search.mockReturnValue(throwError(() => new Error('coordinator down')));

    await expect(firstValueFrom(controller.search(makeDto()))).rejects.toThrow('coordinator down');
  });

  it('passes through optional DTO fields when present', async () => {
    const dto = makeDto({ locale: 'de', limit: 10, offset: 5 });
    searchService.search.mockReturnValue(of(makeResponse()));

    await firstValueFrom(controller.search(dto));

    expect(searchService.search).toHaveBeenCalledWith(expect.objectContaining({ locale: 'de', limit: 10, offset: 5 }));
  });
});
