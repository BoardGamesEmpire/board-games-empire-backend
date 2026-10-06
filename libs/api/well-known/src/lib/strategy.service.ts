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

    // The singleton row, which the auth gates read too: the registration
    // switch advertised below is then the one they enforce (#585).
    const settings = await this.db.systemSetting.findUnique({
      where: { singleton: true },
      select: { identifier: true, name: true, allowUserRegistration: true },
    });
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

    // An anonymous sign-in creates an account, so it is refused while
    // registration is closed (#585).
    dto.bgeAnonymousAuthSupported = settings.allowUserRegistration;

    dto.strategies = this.buildStrategies(settings.allowUserRegistration);

    return dto;
  }

  private buildStrategies(registrationOpen: boolean): AuthStrategyDto[] {
    const strategies: AuthStrategyDto[] = [];

    if (this.configService.get<boolean>('auth.useEmailPasswordAuth')) {
      strategies.push(this.buildEmailAndPasswordStrategy(registrationOpen));
    }

    if (this.isOidcConfigured()) {
      strategies.push(this.buildOidcStrategy(registrationOpen));
    }

    return strategies;
  }

  private buildEmailAndPasswordStrategy(registrationOpen: boolean): EmailAndPasswordStrategyDto {
    const signUpDisabled = !registrationOpen;

    const dto = new EmailAndPasswordStrategyDto();
    dto.signUpDisabled = signUpDisabled;
    dto.signInEndpoint = authPath('/sign-in/email');

    if (!signUpDisabled) {
      dto.signUpEndpoint = authPath('/sign-up/email');
    }

    return dto;
  }

  private buildOidcStrategy(registrationOpen: boolean): OidcStrategyDto {
    const dto = new OidcStrategyDto();
    // Listed either way, since existing accounts sign in through it; only a
    // first sign-in, which creates the account, is refused (#585).
    dto.signUpDisabled = !registrationOpen;
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
