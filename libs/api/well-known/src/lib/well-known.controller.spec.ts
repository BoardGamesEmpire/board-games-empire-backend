import { PoliciesGuard } from '@bge/permissions';
import { createTestingModuleWithDb } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { AuthStrategyType } from './constants';
import { BgeDiscoveryDto } from './dto/bge-discovery.dto';
import { EmailAndPasswordStrategyDto } from './dto/email-and-password-strategy.dto';
import { SecurityTxtService } from './security-txt.service';
import { StrategyService } from './strategy.service';
import { WellKnownController } from './well-known.controller';

const AUTH_BASE = 'https://api.example.com/api/auth';
const ISSUER = 'https://api.example.com';

function makeFullDiscovery(overrides: Partial<BgeDiscoveryDto> = {}): BgeDiscoveryDto {
  const dto = new BgeDiscoveryDto();
  dto.issuer = ISSUER;
  dto.deviceAuthorizationEndpoint = `${AUTH_BASE}/device`;
  dto.bgeAuthBaseUrl = AUTH_BASE;
  dto.bgeSessionEndpoint = `${AUTH_BASE}/get-session`;
  dto.bgeSignOutEndpoint = `${AUTH_BASE}/sign-out`;
  dto.bgePasskeySupported = true;
  dto.bgeTwoFactorSupported = true;
  dto.bgeAnonymousAuthSupported = true;
  dto.strategies = [];
  return { ...dto, ...overrides };
}

const MINIMAL_SECURITY_TXT = [
  '# Security contact information for Board Games Empire',
  '# https://securitytxt.org — RFC 9116',
  '',
  'Contact: mailto:security@example.com',
  'Expires: 2026-06-15T00:00:00.000Z',
  `Canonical: ${ISSUER}/.well-known/security.txt`,
  'Preferred-Languages: en',
  '',
].join('\n');

describe('WellKnownController', () => {
  let controller: WellKnownController;
  let strategyService: jest.Mocked<StrategyService>;
  let securityTxtService: jest.Mocked<SecurityTxtService>;

  beforeEach(async () => {
    const { module } = await createTestingModuleWithDb({
      controllers: [WellKnownController],
      providers: [
        {
          provide: StrategyService,
          useValue: {
            getDiscovery: jest.fn(),
          } satisfies Partial<jest.Mocked<StrategyService>>,
        },
        {
          provide: SecurityTxtService,
          useValue: {
            build: jest.fn(),
            isConfigured: jest.fn(),
          } satisfies Partial<jest.Mocked<SecurityTxtService>>,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn(), getOrThrow: jest.fn() },
        },
      ],
      overrideGuards: [AuthGuard, PoliciesGuard],
    });

    controller = module.get(WellKnownController);
    strategyService = module.get(StrategyService);
    securityTxtService = module.get(SecurityTxtService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getDiscovery()', () => {
    it('delegates to StrategyService.getDiscovery()', () => {
      const discovery = makeFullDiscovery();
      strategyService.getDiscovery.mockReturnValue(discovery);

      const result = controller.getDiscovery();

      expect(strategyService.getDiscovery).toHaveBeenCalledTimes(1);
      expect(result).toBe(discovery);
    });

    it('returns the full discovery document', () => {
      strategyService.getDiscovery.mockReturnValue(makeFullDiscovery());

      const result = controller.getDiscovery();

      expect(result.issuer).toBe(ISSUER);
      expect(result.bgePasskeySupported).toBe(true);
      expect(result.bgeTwoFactorSupported).toBe(true);
      expect(result.bgeAnonymousAuthSupported).toBe(true);
    });

    it('returns an empty strategies array when no strategies are configured', () => {
      strategyService.getDiscovery.mockReturnValue(makeFullDiscovery({ strategies: [] }));

      expect(controller.getDiscovery().strategies).toEqual([]);
    });

    it('returns the discovery document with a configured strategy', () => {
      const emailStrategy = new EmailAndPasswordStrategyDto();
      emailStrategy.signUpDisabled = false;
      emailStrategy.signInEndpoint = `${AUTH_BASE}/sign-in/email`;

      strategyService.getDiscovery.mockReturnValue(makeFullDiscovery({ strategies: [emailStrategy] }));

      const { strategies } = controller.getDiscovery();

      expect(strategies).toHaveLength(1);
      expect(strategies[0].type).toBe(AuthStrategyType.EmailAndPassword);
    });
  });

  describe('getDiscoveryOptions()', () => {
    it('returns undefined (no response body)', () => {
      expect(controller.getDiscoveryOptions()).toBeUndefined();
    });

    it('does not call StrategyService', () => {
      controller.getDiscoveryOptions();
      expect(strategyService.getDiscovery).not.toHaveBeenCalled();
    });
  });

  describe('getSecurityTxt()', () => {
    beforeEach(() => {
      strategyService.getDiscovery.mockReturnValue(makeFullDiscovery());
    });

    it('delegates to SecurityTxtService.build() with the issuer', () => {
      securityTxtService.build.mockReturnValue(MINIMAL_SECURITY_TXT);

      controller.getSecurityTxt();

      expect(securityTxtService.build).toHaveBeenCalledWith(ISSUER);
    });

    it('returns the security.txt body when contact is configured', () => {
      securityTxtService.build.mockReturnValue(MINIMAL_SECURITY_TXT);

      const result = controller.getSecurityTxt();

      expect(result).toBe(MINIMAL_SECURITY_TXT);
    });

    it('throws NotFoundException when SecurityTxtService returns null', () => {
      securityTxtService.build.mockReturnValue(null);

      expect(() => controller.getSecurityTxt()).toThrow(NotFoundException);
    });

    it('throws NotFoundException with a descriptive message', () => {
      securityTxtService.build.mockReturnValue(null);

      expect(() => controller.getSecurityTxt()).toThrow(
        expect.objectContaining({
          message: expect.stringContaining('SECURITY_CONTACT'),
        }),
      );
    });

    it('returns a plain string, not an object (no JSON serialisation)', () => {
      securityTxtService.build.mockReturnValue(MINIMAL_SECURITY_TXT);

      const result = controller.getSecurityTxt();

      expect(typeof result).toBe('string');
    });

    it('retrieves the issuer from the discovery document, not independently', () => {
      const customDiscovery = makeFullDiscovery();
      customDiscovery.issuer = 'https://bge.custom.io';
      strategyService.getDiscovery.mockReturnValue(customDiscovery);
      securityTxtService.build.mockReturnValue(MINIMAL_SECURITY_TXT);

      controller.getSecurityTxt();

      expect(securityTxtService.build).toHaveBeenCalledWith('https://bge.custom.io');
    });
  });

  describe('getSecurityTxtOptions()', () => {
    it('returns undefined (no response body)', () => {
      expect(controller.getSecurityTxtOptions()).toBeUndefined();
    });

    it('does not interact with any service', () => {
      controller.getSecurityTxtOptions();

      expect(strategyService.getDiscovery).not.toHaveBeenCalled();
      expect(securityTxtService.build).not.toHaveBeenCalled();
    });
  });
});
