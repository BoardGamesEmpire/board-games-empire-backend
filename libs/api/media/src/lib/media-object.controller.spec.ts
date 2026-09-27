import { NO_CACHE_KEY } from '@bge/shared';
import { MediaObjectController } from './media-object.controller';

// The list envelopes on this controller are covered in `media-list.controller.spec.ts`.
describe('MediaObjectController', () => {
  describe('signedUrl', () => {
    it('is exempt from the response cache', () => {
      // A signed URL's default lifetime is five minutes, the same as the
      // response cache's TTL, so a cached body hands out URLs that are
      // already expiring (#528).
      expect(Reflect.getMetadata(NO_CACHE_KEY, MediaObjectController.prototype.signedUrl)).toBe(true);
    });
  });
});
