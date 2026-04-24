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
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOkResponse({ type: BgeDiscoveryDto, description: 'BGE server identity and available auth strategies' })
  getDiscovery(): BgeDiscoveryDto {
    return this.strategyService.getDiscovery();
  }

  @Options('bge-identity')
  @UseInterceptors(SnakeCaseInterceptor)
  @HttpCode(204)
  @Header('Allow', 'GET, HEAD, OPTIONS')
  @Header('Cache-Control', 'public, max-age=3600')
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
  getSecurityTxt(): string {
    const issuer = this.strategyService.getDiscovery().issuer;
    const body = this.securityTxtService.build(issuer);

    if (body === null) {
      throw new NotFoundException(
        'security.txt is not configured for this BGE instance. ' + 'Set SECURITY_CONTACT to enable this endpoint.',
      );
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
