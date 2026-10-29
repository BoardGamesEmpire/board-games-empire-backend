import { DatabaseService } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import assert from 'node:assert';
import type { BgeIdentityConfig } from './configuration/bge-identity.config';
import { AUTH_BASE_PATH, authPath, WELL_KNOWN_SCHEMA_VERSION } from './constants';
import { AuthStrategyDto, BgeDiscoveryDto } from './dto/bge-discovery.dto';
import { EmailAndPasswordStrategyDto } from './dto/email-and-password-strategy.dto';
import { OidcStrategyDto } from './dto/oidc-strategy.dto';

/**
 * What discovery lists of a sign-in provider (#912): a slice of the auth lib's
 * provider config, declared here so this lib imports nothing from that one.
 * The client id and secret are not part of it, so they are never in reach.
 */
interface ListedSignInProvider {
  readonly id: string;
  readonly displayName: string;
  readonly discoveryUrl: string;
}

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

    // One per sign-in provider, in the operator's list order (#912). The config
    // refuses a partial provider at startup, so none is half-listed here.
    const providers = this.configService.get<readonly ListedSignInProvider[]>('auth.oidcProviders') ?? [];

    for (const provider of providers) {
      strategies.push(this.buildOidcStrategy(provider, registrationOpen));
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

  private buildOidcStrategy(provider: ListedSignInProvider, registrationOpen: boolean): OidcStrategyDto {
    const dto = new OidcStrategyDto();
    // Listed either way, since existing accounts sign in through it; only a
    // first sign-in, which creates the account, is refused (#585).
    dto.signUpDisabled = !registrationOpen;
    dto.providerId = provider.id;
    // The operator's label: a proper noun, so it is never localized (#912).
    dto.displayName = provider.displayName;
    // discoveryUrl points at the sign-in provider, so it stays an absolute URL.
    dto.discoveryUrl = provider.discoveryUrl;
    dto.authorizationEndpoint = authPath('/sign-in/oauth2');
    return dto;
  }
}
