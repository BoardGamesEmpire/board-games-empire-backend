import { t } from '@bge/i18n';
import { Controller, Get, Header, HttpCode, NotFoundException, Options, UseInterceptors } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { BgeDiscoveryDto } from './dto/bge-discovery.dto';
import { SnakeCaseInterceptor } from './interceptors/snakecase.interceptor';
import { SecurityTxtService } from './security-txt.service';
import { StrategyService } from './strategy.service';

/**
 * Serves RFC 8615 well-known URIs for BGE server discovery.
 *
 * Deliberately NOT `@SkipThrottle()`, unlike `/health` and `/metrics`. Those are
 * infrastructure endpoints whose failure breaks operations; this is public
 * traffic, and rate limiting it is appropriate.
 *
 * The accepted cost, stated plainly because it is not obvious: the bucket is
 * keyed on handler and source IP, so callers sharing an address — one NAT, one
 * corporate proxy, one CGNAT range — share this endpoint's budget and CAN 429
 * each other.
 *
 * `Cache-Control: public, max-age=300` below makes that unlikely to bite rather
 * than impossible. The header permits caching; it does not oblige a client to
 * cache, retain, or reuse anything, so a well-behaved client that revalidates
 * eagerly still reaches the endpoint. The limit is a backstop against volume,
 * not a guarantee derived from the caching policy.
 *
 * If federation ever puts a large shared-egress population behind one address,
 * this is the endpoint that notices first, and the answer is a route-level
 * limit rather than an exemption.
 */
@ApiTags('well-known')
@AllowAnonymous()
@Controller('.well-known')
export class WellKnownController {
  constructor(
    private readonly strategyService: StrategyService,
    private readonly securityTxtService: SecurityTxtService,
  ) {}

  /**
   * BGE server identity and authentication discovery document.
   * Modeled after RFC 8414 and OpenID Connect Discovery.
   * Keys are snake_case per de-facto auth discovery convention.
   */
  @Get('bge-identity')
  @UseInterceptors(SnakeCaseInterceptor)
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOkResponse({ type: BgeDiscoveryDto, description: 'BGE server identity and available auth strategies' })
  getDiscovery(): Promise<BgeDiscoveryDto> {
    return this.strategyService.getDiscovery();
  }

  @Options('bge-identity')
  @UseInterceptors(SnakeCaseInterceptor)
  @HttpCode(Http.NoContent)
  @Header('Allow', 'GET, HEAD, OPTIONS')
  @Header('Cache-Control', 'public, max-age=300')
  @ApiNoContentResponse({ description: 'Supported methods for /.well-known/bge-identity' })
  getDiscoveryOptions(): void {
    // Intentionally empty — headers carry the response
  }

  /**
   * Security contact information for this BGE instance.
   *
   * Returns 404 when SECURITY_CONTACT is not configured — operators who have
   * not set up a disclosure contact should not serve this file at all.
   *
   * Content-Type is text/plain per RFC 9116 §3. SnakeCaseInterceptor is
   * intentionally NOT applied here.
   */
  @Get('security.txt')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=86400')
  @ApiOkResponse({ description: 'RFC 9116 security contact document' })
  async getSecurityTxt(): Promise<string> {
    const discovery = await this.strategyService.getDiscovery();
    const issuer = discovery.issuer;
    const body = this.securityTxtService.build(issuer);

    if (body === null) {
      throw new NotFoundException(t('errors.well_known.security_txt_not_configured'));
    }

    return body;
  }

  @Options('security.txt')
  @HttpCode(Http.NoContent)
  @Header('Allow', 'GET, HEAD, OPTIONS')
  @Header('Cache-Control', 'public, max-age=86400')
  @ApiNoContentResponse({ description: 'Supported methods for /.well-known/security.txt' })
  getSecurityTxtOptions(): void {
    // Intentionally empty — headers carry the response
  }
}
