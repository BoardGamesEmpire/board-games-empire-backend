import { withEnvironment } from '@bge/testing';
import healthConfig from './health.config';

describe('health config: HTTP_HEALTH_CHECK_URLS', () => {
  // A fresh server sends nothing to a third party unasked, so `/health` has no
  // HTTP target until an operator lists one (#1509).
  it('reads as no entries when unset', () => {
    expect(withEnvironment({ NODE_ENV: 'test' }, healthConfig).httpHealthCheckUrls).toEqual([]);
  });

  it('reads as no entries when set to an empty string', () => {
    expect(withEnvironment({ NODE_ENV: 'test', HTTP_HEALTH_CHECK_URLS: '' }, healthConfig).httpHealthCheckUrls).toEqual(
      [],
    );
  });

  it('reads a listed target as one trimmed entry', () => {
    expect(
      withEnvironment({ NODE_ENV: 'test', HTTP_HEALTH_CHECK_URLS: ' site|https://example.com ' }, healthConfig)
        .httpHealthCheckUrls,
    ).toEqual(['site|https://example.com']);
  });
});
