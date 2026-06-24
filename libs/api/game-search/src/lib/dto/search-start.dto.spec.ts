import { plainToInstance } from 'class-transformer';
import { SearchStartDto } from './search-start.dto';

describe('SearchStartDto', () => {
  // The search gateway validates @MessageBody with enableImplicitConversion on
  // (apps/api/src/app/gateways/game/search.gateway.ts), so mirror that here.
  const toDto = (plain: Record<string, unknown>): SearchStartDto =>
    plainToInstance(SearchStartDto, plain, { enableImplicitConversion: true });

  const base = { correlationId: 'c1', query: 'Hades' };

  describe('includeLocal / includeExternal', () => {
    it('default to true when absent', () => {
      const dto = toDto(base);
      expect(dto.includeLocal).toBe(true);
      expect(dto.includeExternal).toBe(true);
    });

    it('accept real booleans from a JSON message body', () => {
      const dto = toDto({ ...base, includeLocal: false, includeExternal: false });
      expect(dto.includeLocal).toBe(false);
      expect(dto.includeExternal).toBe(false);
    });

    it("parse the string 'false' as false", () => {
      const dto = toDto({ ...base, includeLocal: 'false', includeExternal: 'false' });
      expect(dto.includeLocal).toBe(false);
      expect(dto.includeExternal).toBe(false);
    });
  });
});
