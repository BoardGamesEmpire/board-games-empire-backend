import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_BASE_PATH } from './constants';
import { AuthStrategyDto, BgeDiscoveryDto } from './dto/bge-discovery.dto';
import { EmailAndPasswordStrategyDto } from './dto/email-and-password-strategy.dto';
import { OidcStrategyDto } from './dto/oidc-strategy.dto';

@Injectable()
export class StrategyService {
  constructor(private readonly configService: ConfigService) {}

  getDiscovery(): BgeDiscoveryDto {
    const issuer = this.configService.getOrThrow<string>('auth.url');
    const authBase = `${issuer}${AUTH_BASE_PATH}`;

    const dto = new BgeDiscoveryDto();

    // RFC 8414-aligned fields
    dto.issuer = issuer;
    dto.deviceAuthorizationEndpoint = `${authBase}/device`;

    // infrastructure endpoints
    dto.bgeAuthBaseUrl = authBase;
    dto.bgeSessionEndpoint = `${authBase}/get-session`;
    dto.bgeSignOutEndpoint = `${authBase}/sign-out`;

    // capability flags
    // TODO: make configurable
    dto.bgePasskeySupported = true;
    dto.bgeTwoFactorSupported = true;
    dto.bgeAnonymousAuthSupported = true;

    dto.strategies = this.buildStrategies(authBase);

    return dto;
  }

  private buildStrategies(authBase: string): AuthStrategyDto[] {
    const strategies: AuthStrategyDto[] = [];

    if (this.configService.get<boolean>('auth.useEmailPasswordAuth')) {
      strategies.push(this.buildEmailAndPasswordStrategy(authBase));
    }

    if (this.isOidcConfigured()) {
      strategies.push(this.buildOidcStrategy(authBase));
    }

    return strategies;
  }

  private buildEmailAndPasswordStrategy(authBase: string): EmailAndPasswordStrategyDto {
    const signUpDisabled = this.configService.get<boolean>('auth.disableEmailSignUp') ?? false;

    const dto = new EmailAndPasswordStrategyDto();
    dto.signUpDisabled = signUpDisabled;
    dto.signInEndpoint = `${authBase}/sign-in/email`;

    if (!signUpDisabled) {
      dto.signUpEndpoint = `${authBase}/sign-up/email`;
    }

    return dto;
  }

  private buildOidcStrategy(authBase: string): OidcStrategyDto {
    const dto = new OidcStrategyDto();
    dto.providerId = this.configService.get<string>('auth.oidcProviderId') || 'default-oidc-provider';
    dto.discoveryUrl = this.configService.getOrThrow<string>('auth.oidcWellKnownUrl');
    dto.authorizationEndpoint = `${authBase}/sign-in/oauth2`;
    return dto;
  }

  private isOidcConfigured(): boolean {
    const wellKnownUrl = this.configService.get<string>('auth.oidcWellKnownUrl');
    const clientId = this.configService.get<string>('auth.oidcClientId');
    const clientSecret = this.configService.get<string>('auth.oidcClientSecret');
    return Boolean(wellKnownUrl && clientId && clientSecret);
  }
}
