import type { Actor } from '@bge/actor-context';
import { AuditContextService } from '@bge/actor-context';
import type { UpstreamAccount } from '@bge/database';
import { Action, ResourceType, Upstream } from '@bge/database';
import { CodedHttpException, I18nExceptionFilter, LocaleResolutionService, t } from '@bge/i18n';
import type { AppAbility } from '@bge/permissions';
import { CHECK_POLICIES_KEY, PoliciesGuard } from '@bge/permissions';
import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import { I18nService, I18nValidationPipe } from 'nestjs-i18n';
import { UpstreamAccountErrorCode } from '../upstream-account.constants';
import { UpstreamThrottledException } from '../upstream-throttled.exception';
import { BggLinkController } from './bgg-link.controller';
import { BggLinkService } from './bgg-link.service';
import { LINK_USERNAME_MAX_LENGTH } from './dto/link-by-username.dto';

/** The keys better-auth's decorators write, read off the decorators: the package does not export them. */
const ALLOW_ANONYMOUS_KEY = AllowAnonymous().KEY;
const OPTIONAL_AUTH_KEY = OptionalAuth().KEY;

const ME = 'user-1';
const user: Actor = { kind: 'user', userId: ME };

const linked: UpstreamAccount = {
  id: 'ua-1',
  userId: ME,
  upstream: Upstream.BoardGameGeek,
  externalId: 'BGFan',
  displayName: null,
  profileUrl: 'https://boardgamegeek.com/user/BGFan',
  verified: false,
  createdAt: new Date('2026-11-19T10:00:00.000Z'),
  updatedAt: new Date('2026-11-19T10:00:00.000Z'),
};

describe('BggLinkController (#1226)', () => {
  describe('routes', () => {
    const { link } = BggLinkController.prototype;

    it('serves POST /api/users/me/upstream-accounts/boardgamegeek', () => {
      expect(Reflect.getMetadata(PATH_METADATA, BggLinkController)).toBe('users/me/upstream-accounts/boardgamegeek');
      expect(Reflect.getMetadata(PATH_METADATA, link)).toBe('/');
    });

    it('needs a signed-in user: neither @OptionalAuth() nor @AllowAnonymous()', () => {
      for (const target of [BggLinkController, link]) {
        expect(Reflect.getMetadata(OPTIONAL_AUTH_KEY, target)).toBeUndefined();
        expect(Reflect.getMetadata(ALLOW_ANONYMOUS_KEY, target)).toBeUndefined();
      }
    });

    it('puts PoliciesGuard on the class', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, BggLinkController)).toEqual([PoliciesGuard]);
    });

    it('lets only a holder of create on UpstreamAccount link', () => {
      const policies = Reflect.getMetadata(CHECK_POLICIES_KEY, link) as Array<(ability: AppAbility) => boolean>;
      const can = jest.fn();
      const ability = { can } as unknown as AppAbility;

      expect(policies).toHaveLength(1);
      can.mockReturnValue(true);
      expect(policies[0](ability)).toBe(true);
      can.mockReturnValue(false);
      expect(policies[0](ability)).toBe(false);
      expect(can).toHaveBeenCalledWith(Action.create, ResourceType.UpstreamAccount);
    });
  });

  /**
   * The route over a real (minimal) Nest HTTP app: the api's global prefix and
   * validation pipe, and the edge filter that renders an error answer, over a
   * fake link service.
   */
  describe('over HTTP', () => {
    let app: INestApplication;
    let base: string;
    const getActor = jest.fn<Actor | null, []>();
    const linkAccount = jest.fn<Promise<UpstreamAccount>, [string, string]>();

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        controllers: [BggLinkController],
        providers: [
          { provide: BggLinkService, useValue: { link: linkAccount } },
          { provide: AuditContextService, useValue: { getActor, getLocale: () => 'en' } },
          { provide: I18nService, useValue: { translate: (key: string) => `rendered:${key}` } },
          { provide: LocaleResolutionService, useValue: { resolveAcceptLanguage: () => 'en' } },
          { provide: APP_FILTER, useClass: I18nExceptionFilter },
        ],
      })
        .overrideGuard(PoliciesGuard)
        .useValue({ canActivate: () => true })
        .compile();

      app = module.createNestApplication();
      // As main.ts sets them up.
      app.setGlobalPrefix('api');
      app.useGlobalPipes(
        new I18nValidationPipe({
          forbidNonWhitelisted: true,
          transform: true,
          whitelist: true,
          validationError: { target: false, value: false },
          transformOptions: { enableImplicitConversion: true },
        }),
      );
      await app.listen(0);
      base = await app.getUrl();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      jest.clearAllMocks();
      getActor.mockReturnValue(user);
      linkAccount.mockResolvedValue(linked);
    });

    const post = (body: unknown) =>
      fetch(`${base}/api/users/me/upstream-accounts/boardgamegeek`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('links the trimmed username for the signed-in user, and answers the account unverified', async () => {
      const answer = await post({ username: '  bgfan \t' });

      expect(answer.status).toBe(HttpStatus.CREATED);
      expect(linkAccount).toHaveBeenCalledWith(ME, 'bgfan');
      // The message is a marker until the api's response interceptor renders
      // it, which this app leaves out.
      await expect(answer.json()).resolves.toEqual({
        message: expect.objectContaining({
          key: 'success.upstream_account.linked_by_username',
          args: { upstream: Upstream.BoardGameGeek },
        }),
        upstreamAccount: {
          upstream: 'boardgamegeek',
          externalId: 'BGFan',
          displayName: null,
          profileUrl: 'https://boardgamegeek.com/user/BGFan',
          verified: false,
          linkedAt: '2026-11-19T10:00:00.000Z',
        },
      });
    });

    it.each([
      ['no username', {}],
      ['an empty username', { username: '' }],
      ['a username of only spaces', { username: '   ' }],
      ['a username too long', { username: 'x'.repeat(LINK_USERNAME_MAX_LENGTH + 1) }],
      ['a field the route does not take', { username: 'bgfan', password: 'hunter2' }],
    ])('refuses %s with 400, asking no one', async (_, body) => {
      const answer = await post(body);

      expect(answer.status).toBe(HttpStatus.BAD_REQUEST);
      expect(linkAccount).not.toHaveBeenCalled();
    });

    it(`takes a username of ${LINK_USERNAME_MAX_LENGTH} characters`, async () => {
      const answer = await post({ username: 'x'.repeat(LINK_USERNAME_MAX_LENGTH) });

      expect(answer.status).toBe(HttpStatus.CREATED);
    });

    // An API key acts for its owner but is not the owner, and an anonymous
    // user's identity is only temporary (#1226, as #935's Steam link).
    it.each<[string, Actor]>([
      ['an API key', { kind: 'apiKey', apiKeyId: 'key-1', userId: ME }],
      ['an anonymous user', { kind: 'anonymous', userId: ME }],
    ])('refuses %s with 403, asking no one', async (_, actor) => {
      getActor.mockReturnValue(actor);

      const answer = await post({ username: 'bgfan' });

      expect(answer.status).toBe(HttpStatus.FORBIDDEN);
      expect(linkAccount).not.toHaveBeenCalled();
    });

    // A client or proxy that reads only the header still waits as the
    // DataGateway asked: the body's retryAfterMs is milliseconds, the header
    // whole seconds (#1226).
    it('answers a throttled link 503 with Retry-After in seconds beside retryAfterMs', async () => {
      linkAccount.mockRejectedValue(new UpstreamThrottledException(Upstream.BoardGameGeek, 12_500));

      const answer = await post({ username: 'bgfan' });

      expect(answer.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(answer.headers.get('retry-after')).toBe('13');
      await expect(answer.json()).resolves.toMatchObject({ code: 'UPSTREAM_THROTTLED', retryAfterMs: 12_500 });
    });

    it('sends no Retry-After with any other refusal', async () => {
      linkAccount.mockRejectedValue(
        new CodedHttpException(
          HttpStatus.SERVICE_UNAVAILABLE,
          UpstreamAccountErrorCode.Unreachable,
          t('errors.upstream_account.unreachable', { upstream: Upstream.BoardGameGeek }),
        ),
      );

      const answer = await post({ username: 'bgfan' });

      expect(answer.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(answer.headers.get('retry-after')).toBeNull();
    });
  });
});
