import { t } from '@bge/i18n';
import { NoCache } from '@bge/shared';
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
 * Caching does not soften that. The discovery document is `no-cache`, so a
 * client revalidates it on every use, and a 304 spends the budget as a 200
 * does. The limit is a backstop against volume, not a guarantee derived from
 * the caching policy.
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
   *
   * Never served stale, by the api or by an HTTP cache (#585). The document
   * advertises the settings row's registration switch, and a cached body
   * would keep offering sign-up after an admin closed it, while the server
   * refuses every attempt. The api's response cache is skipped: its keys are
   * per caller and locale, so a PATCH has no one entry it could evict
   * instead. `no-cache` lets an HTTP cache keep a copy but makes it
   * revalidate on every use, and the ETag Express sets lets an unchanged
   * document answer 304 without its body.
   */
  @Get('bge-identity')
  @NoCache()
  @UseInterceptors(SnakeCaseInterceptor)
  @Header('Cache-Control', 'no-cache')
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
