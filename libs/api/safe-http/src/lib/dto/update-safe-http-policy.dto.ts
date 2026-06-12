import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { IsCidrArray, IsHostnameOrWildcardArray } from './validators';

/**
 * Partial update for the `SafeHttpPolicy` singleton row. PATCH semantics:
 * fields omitted from the request remain unchanged; explicit empty arrays
 * clear the corresponding list.
 *
 * Cross-field validation (strict mode rejecting wildcards) happens in the
 * service layer because it depends on the effective post-update state,
 * which a single-field validator can't see.
 */
export class UpdateSafeHttpPolicyDto {
  @ApiProperty({
    description:
      'Default per-request timeout in milliseconds. Bounded between 1s and 5m to prevent foot-gun misconfigurations. Callers may override per-call via `SafeHttpRequestOptions.timeoutMs`.',
    minimum: 1000,
    maximum: 300_000,
  })
  @IsInt()
  @Min(1000)
  @Max(300_000)
  @IsOptional()
  defaultTimeoutMs?: number;

  @ApiProperty({
    description:
      'Default cap on redirect hops. 0 disables redirect following entirely. Each hop re-runs the full SSRF gauntlet regardless of this value.',
    minimum: 0,
    maximum: 20,
  })
  @IsInt()
  @Min(0)
  @Max(20)
  @IsOptional()
  defaultMaxRedirects?: number;

  @ApiProperty({
    description:
      'When true, wildcard entries (e.g. "*.example.com") are rejected in `allowedHosts` and `blockedHosts`. When false, wildcards are accepted with right-anchored suffix matching.',
  })
  @IsBoolean()
  @IsOptional()
  strictMode?: boolean;

  @ApiProperty({
    description:
      'Hostnames that bypass the default private-range SSRF rejection. Lower-cased on store. Wildcards (`*.example.com`) are permitted only when `strictMode` is false.',
    type: [String],
    example: ['jenkins.local', 'minio.internal'],
  })
  @IsArray()
  @IsHostnameOrWildcardArray()
  @IsOptional()
  allowedHosts?: string[];

  @ApiProperty({
    description:
      'CIDR ranges that bypass the default private-range SSRF rejection. Useful for self-hosters whose deployment lives entirely inside a private subnet.',
    type: [String],
    example: ['10.0.0.0/8', 'fc00::/7'],
  })
  @IsArray()
  @IsCidrArray()
  @IsOptional()
  allowedCidrs?: string[];

  @ApiProperty({
    description:
      'Hostnames that are always blocked. Cannot be overridden by `allowedHosts` or by per-call options. Wildcards (`*.example.com`) are permitted only when `strictMode` is false.',
    type: [String],
  })
  @IsArray()
  @IsHostnameOrWildcardArray()
  @IsOptional()
  blockedHosts?: string[];

  @ApiProperty({
    description: 'CIDR ranges that are always blocked. Cannot be overridden by `allowedCidrs` or by per-call options.',
    type: [String],
  })
  @IsArray()
  @IsCidrArray()
  @IsOptional()
  blockedCidrs?: string[];
}
