import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { WsGameSearchResult, WsSearchErrorPayload } from './search-outbound.dto';

/**
 * Unified REST response that collapses the multi-frame WS protocol
 * (search:result, search:source_done, search:error, etc.) into a
 * single JSON payload.
 */
export class SearchResponseDto {
  @ApiProperty({ description: 'Correlation ID echoed from the request' })
  correlationId!: string;

  @ApiProperty({
    description: 'Search results grouped by source (gateway ID or "local")',
    type: 'object',
    additionalProperties: { type: 'array' },
  })
  resultsBySource!: Record<string, WsGameSearchResult[]>;

  @ApiPropertyOptional({
    description: 'Errors keyed by source, if any gateways failed',
    type: 'object',
    additionalProperties: { type: 'object' },
  })
  errors?: Record<string, Pick<WsSearchErrorPayload, 'message'>>;

  @ApiPropertyOptional({
    description: 'Sources that reported rate limiting',
    type: 'array',
    items: { type: 'string' },
  })
  rateLimitedSources?: string[];

  @ApiPropertyOptional({
    description: 'Sources that were unavailable',
    type: 'array',
    items: { type: 'string' },
  })
  unavailableSources?: string[];
}
