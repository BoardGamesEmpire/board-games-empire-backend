import type { Attributes } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { QueryWithholdingSpanProcessor } from './query-withholding.span-processor';

const RETURN_PATH = '/api/users/me/upstream-accounts/steam/return';
const STEAM_QUERY = 'state=s1&openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561197960287930';

describe('QueryWithholdingSpanProcessor (#935)', () => {
  let processor: QueryWithholdingSpanProcessor;
  let exporter: InMemorySpanExporter;
  let provider: TracerProvider;

  /** Starts and ends a span with `attributes`, through the processor as the SDK runs it, and answers what was exported. */
  const exported = (attributes: Attributes): Attributes => {
    provider.getTracer('spec').startSpan('GET', { attributes }).end();
    const [span] = exporter.getFinishedSpans();

    return span.attributes;
  };

  beforeEach(() => {
    processor = new QueryWithholdingSpanProcessor();
    exporter = new InMemorySpanExporter();
    provider = new TracerProvider({ spanProcessors: [processor, new SimpleSpanProcessor({ exporter })] });
  });

  afterEach(() => provider.shutdown());

  it("drops the query from the HTTP server span's older address attributes for a withheld path", () => {
    processor.withholdQueryFor([RETURN_PATH]);

    const attributes = exported({
      'http.url': `http://localhost:33333${RETURN_PATH}?${STEAM_QUERY}`,
      'http.target': `${RETURN_PATH}?${STEAM_QUERY}`,
      'http.method': 'GET',
    });

    expect(attributes).toEqual({
      'http.url': `http://localhost:33333${RETURN_PATH}`,
      'http.target': RETURN_PATH,
      'http.method': 'GET',
    });
  });

  it("removes url.query from the HTTP server span's current attributes for a withheld path", () => {
    processor.withholdQueryFor([RETURN_PATH]);

    const attributes = exported({ 'url.path': RETURN_PATH, 'url.query': STEAM_QUERY, 'url.scheme': 'http' });

    expect(attributes).toEqual({ 'url.path': RETURN_PATH, 'url.scheme': 'http' });
  });

  it("drops the query from the NestJS handler span's original URL for a withheld path", () => {
    processor.withholdQueryFor([RETURN_PATH]);

    expect(exported({ 'http.url': `${RETURN_PATH}?${STEAM_QUERY}` })).toEqual({ 'http.url': RETURN_PATH });
    exporter.reset();
    expect(exported({ 'url.full': `${RETURN_PATH}?${STEAM_QUERY}` })).toEqual({ 'url.full': RETURN_PATH });
  });

  it('matches the path as Express routes it: any case, with a trailing slash', () => {
    processor.withholdQueryFor([RETURN_PATH]);

    const attributes = exported({ 'http.target': `${RETURN_PATH.toUpperCase()}/?${STEAM_QUERY}` });

    expect(attributes).toEqual({ 'http.target': `${RETURN_PATH.toUpperCase()}/` });
  });

  it("keeps another path's query", () => {
    processor.withholdQueryFor([RETURN_PATH]);

    const attributes = {
      'http.target': '/api/games/search?q=catan',
      'url.path': '/api/games/search',
      'url.query': 'q=catan',
    };

    expect(exported(attributes)).toEqual(attributes);
  });

  it('keeps every query until a path is withheld', () => {
    const attributes = { 'http.target': `${RETURN_PATH}?${STEAM_QUERY}` };

    expect(exported(attributes)).toEqual(attributes);
  });

  it('leaves a span that records no request alone', () => {
    processor.withholdQueryFor([RETURN_PATH]);

    expect(exported({ 'db.system': 'postgresql' })).toEqual({ 'db.system': 'postgresql' });
  });
});
