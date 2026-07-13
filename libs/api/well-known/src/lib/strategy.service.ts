import { DatabaseService } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import assert from 'node:assert';
import type { BgeIdentityConfig } from './configuration/bge-identity.config';
import { AUTH_BASE_PATH, authPath, WELL_KNOWN_SCHEMA_VERSION } from './constants';
import { AuthStrategyDto, BgeDiscoveryDto } from './dto/bge-discovery.dto';
import { EmailAndPasswordStrategyDto } from './dto/email-and-password-strategy.dto';
import { OidcStrategyDto } from './dto/oidc-strategy.dto';

@Injectable()
export class StrategyService {
  constructor(
    private readonly configService: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  async getDiscovery(): Promise<BgeDiscoveryDto> {
    const issuer = this.configService.getOrThrow<string>('auth.url');

    const dto = new BgeDiscoveryDto();

    const settings = await this.db.systemSetting.findFirst();
    assert(settings, 'System settings not found in database');

    dto.wellKnownSchemaVersion = WELL_KNOWN_SCHEMA_VERSION;
    dto.bgeServerId = settings.identifier;
    dto.name = settings.name;

    // client version compatibility bounds (empty config = no bound)
    const identity = this.configService.get<BgeIdentityConfig>('bgeIdentity');
    dto.bgeMinClientVersion = identity?.minClientVersion || null;
    dto.bgeMaxClientVersion = identity?.maxClientVersion || null;

    // RFC 8414-style field *names* — the values are BGE-specific, not RFC-compliant:
    // `issuer` is the absolute canonical base URL, while every BGE endpoint below is
    // a root-relative path clients resolve against it (or their configured server URL).
    dto.issuer = issuer;
    dto.deviceAuthorizationEndpoint = authPath('/device');

    // infrastructure endpoints (relative paths)
    dto.bgeAuthBasePath = AUTH_BASE_PATH;
    dto.bgeSessionEndpoint = authPath('/get-session');
    dto.bgeSignOutEndpoint = authPath('/sign-out');

    // capability flags — always-on plugins (see auth-factory.ts)
    dto.bgePasskeySupported = true;
    dto.bgeTwoFactorSupported = true;
    dto.bgeAnonymousAuthSupported = true;

    dto.strategies = this.buildStrategies();

    return dto;
  }

  private buildStrategies(): AuthStrategyDto[] {
    const strategies: AuthStrategyDto[] = [];

    if (this.configService.get<boolean>('auth.useEmailPasswordAuth')) {
      strategies.push(this.buildEmailAndPasswordStrategy());
    }

    if (this.isOidcConfigured()) {
      strategies.push(this.buildOidcStrategy());
    }

    return strategies;
  }

  private buildEmailAndPasswordStrategy(): EmailAndPasswordStrategyDto {
    const signUpDisabled = this.configService.get<boolean>('auth.disableEmailSignUp') ?? false;

    const dto = new EmailAndPasswordStrategyDto();
    dto.signUpDisabled = signUpDisabled;
    dto.signInEndpoint = authPath('/sign-in/email');

    if (!signUpDisabled) {
      dto.signUpEndpoint = authPath('/sign-up/email');
    }

    return dto;
  }

  private buildOidcStrategy(): OidcStrategyDto {
    const dto = new OidcStrategyDto();
    dto.providerId = this.configService.get<string>('auth.oidcProviderId') || 'default-oidc-provider';
    // discoveryUrl points at an external IdP, so it stays an absolute URL.
    dto.discoveryUrl = this.configService.getOrThrow<string>('auth.oidcWellKnownUrl');
    dto.authorizationEndpoint = authPath('/sign-in/oauth2');
    return dto;
  }

  private isOidcConfigured(): boolean {
    const wellKnownUrl = this.configService.get<string>('auth.oidcWellKnownUrl');
    const clientId = this.configService.get<string>('auth.oidcClientId');
    const clientSecret = this.configService.get<string>('auth.oidcClientSecret');
    return Boolean(wellKnownUrl && clientId && clientSecret);
  }
}
