import type { UpstreamAccount } from '@bge/database';
import { Prisma, ResourceType, Upstream } from '@bge/database';
import { uniqueViolation, uniqueViolationWithoutMeta } from '@bge/database/testing';
import { CodedHttpException } from '@bge/i18n';
import type { PrivacyPolicyDto } from '@bge/system-settings';
import { PrivacyPolicyService } from '@bge/system-settings';
import type { MockDatabaseService } from '@bge/testing';
import { createTestingModuleWithDb } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Http, PrismaError } from '@status/codes';
import { UpstreamAccountErrorCode } from './upstream-account.constants';
import {
  UpstreamAccountEvents,
  UpstreamAccountLinkedEvent,
  UpstreamAccountUnlinkedEvent,
} from './upstream-account.events';
import { UpstreamAccountService } from './upstream-account.service';

const ME = 'user-1';
const STEAM_ID = '76561197960287930';

/** The composed scope the controller hands in, as a sentinel the queries must carry. */
const SCOPE = { AND: [{ id: 'sentinel-condition' }] } satisfies Prisma.UpstreamAccountWhereInput;

const account = (overrides: Partial<UpstreamAccount> = {}): UpstreamAccount => ({
  id: 'ua-1',
  userId: ME,
  upstream: Upstream.Steam,
  externalId: STEAM_ID,
  displayName: null,
  profileUrl: `https://steamcommunity.com/profiles/${STEAM_ID}`,
  verified: true,
  createdAt: new Date('2026-11-19T10:00:00.000Z'),
  updatedAt: new Date('2026-11-19T10:00:00.000Z'),
  ...overrides,
});

/** Every column but `createdAt`, as the events carry a row. */
const snapshotOf = (row: UpstreamAccount) => ({
  id: row.id,
  userId: row.userId,
  upstream: row.upstream,
  externalId: row.externalId,
  displayName: row.displayName,
  profileUrl: row.profileUrl,
  verified: row.verified,
  updatedAt: row.updatedAt,
});

const recordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('No record was found for a delete.', {
    code: PrismaError.DependentRecordNotFound,
    clientVersion: 'test',
  });

const policy: PrivacyPolicyDto = {
  availableLanguages: ['de', 'en'],
  language: 'de',
  markdown: '# Datenschutz\n',
  source: 'standard',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

const STEAM_INPUT = {
  userId: ME,
  upstream: Upstream.Steam,
  externalId: STEAM_ID,
  profileUrl: `https://steamcommunity.com/profiles/${STEAM_ID}`,
  verified: true,
};

/** The refusal `promise` rejects with, so a test can read its status, code and body. */
async function refusal(promise: Promise<unknown>): Promise<CodedHttpException> {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(CodedHttpException);
  return error as CodedHttpException;
}

describe('UpstreamAccountService (#935)', () => {
  let service: UpstreamAccountService;
  let db: MockDatabaseService;
  const emit = jest.fn();
  const readFor = jest.fn<Promise<PrivacyPolicyDto>, [unknown]>();

  beforeEach(async () => {
    emit.mockReset();
    readFor.mockReset().mockResolvedValue(policy);

    const ctx = await createTestingModuleWithDb({
      providers: [
        UpstreamAccountService,
        { provide: EventEmitter2, useValue: { emit } },
        { provide: PrivacyPolicyService, useValue: { readFor } },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(UpstreamAccountService);
  });

  describe('linkableUpstreams', () => {
    it('reads the upstreams an enabled, undeleted DataGateway declares (#935)', async () => {
      db.dataGateway.findMany.mockResolvedValue([{ upstream: Upstream.Steam }] as never);

      await service.linkableUpstreams();

      expect(db.dataGateway.findMany).toHaveBeenCalledWith({
        where: { enabled: true, deletedAt: null, upstream: { not: null } },
        select: { upstream: true },
        distinct: ['upstream'],
        orderBy: { upstream: 'asc' },
      });
    });

    // The list tells a client which upstreams to offer a link for, so it names
    // only those this server has a way to link (#935): IGDB has none.
    it('answers only the declared upstreams this server can link', async () => {
      db.dataGateway.findMany.mockResolvedValue([{ upstream: Upstream.IGDB }, { upstream: Upstream.Steam }] as never);

      await expect(service.linkableUpstreams()).resolves.toEqual([Upstream.Steam]);
    });

    it.each([[Upstream.IGDB], [Upstream.BoardGameGeek]])(
      'makes nothing linkable when the only DataGateway declares %s',
      async (upstream) => {
        db.dataGateway.findMany.mockResolvedValue([{ upstream }] as never);

        await expect(service.linkableUpstreams()).resolves.toEqual([]);
      },
    );

    it('makes nothing linkable when no DataGateway declares an upstream', async () => {
      db.dataGateway.findMany.mockResolvedValue([]);

      await expect(service.linkableUpstreams()).resolves.toEqual([]);
    });
  });

  describe('list', () => {
    it("reads the user's accounts within the composed scope, ordered by upstream", async () => {
      const rows = [account()];
      db.upstreamAccount.findMany.mockResolvedValue(rows);

      await expect(service.list(ME, SCOPE)).resolves.toBe(rows);

      expect(db.upstreamAccount.findMany).toHaveBeenCalledWith({
        where: { AND: [SCOPE, { userId: ME }] },
        orderBy: { upstream: 'asc' },
      });
    });
  });

  describe('unlink', () => {
    it('unlinks within the composed scope and emits upstream_account.unlinked with the row it deleted', async () => {
      const row = account();
      db.upstreamAccount.findFirst.mockResolvedValue({ id: row.id } as never);
      db.upstreamAccount.delete.mockResolvedValue(snapshotOf(row) as never);

      await service.unlink(ME, Upstream.Steam, SCOPE);

      // The scope sits in each query's top-level `where`, beside plain fields
      // only: no compound unique key, which Prisma refuses inside an `AND`.
      expect(db.upstreamAccount.findFirst).toHaveBeenCalledWith({
        where: { AND: [SCOPE, { userId: ME, upstream: Upstream.Steam }] },
        select: { id: true },
      });
      expect(db.upstreamAccount.delete).toHaveBeenCalledWith({
        where: { id: row.id, AND: [SCOPE] },
        select: {
          id: true,
          userId: true,
          upstream: true,
          externalId: true,
          displayName: true,
          profileUrl: true,
          verified: true,
          updatedAt: true,
        },
      });
      expect(emit).toHaveBeenCalledTimes(1);
      const [name, event] = emit.mock.calls[0];
      expect(name).toBe(UpstreamAccountEvents.Unlinked);
      expect(name).toBe('upstream_account.unlinked');
      expect(event).toBeInstanceOf(UpstreamAccountUnlinkedEvent);
      expect(event).toMatchObject({
        before: snapshotOf(row),
        after: null,
        subject: ResourceType.UpstreamAccount,
        subjectId: row.id,
        action: 'delete',
      });
    });

    it('answers UPSTREAM_ACCOUNT_NOT_FOUND when the user has no account at that upstream', async () => {
      db.upstreamAccount.findFirst.mockResolvedValue(null);

      const error = await refusal(service.unlink(ME, Upstream.Steam, SCOPE));

      expect(error.getStatus()).toBe(Http.NotFound);
      expect(error.code).toBe(UpstreamAccountErrorCode.NotFound);
      expect(error.code).toBe('UPSTREAM_ACCOUNT_NOT_FOUND');
      expect(db.upstreamAccount.delete).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('answers UPSTREAM_ACCOUNT_NOT_FOUND when another unlink deletes the account first', async () => {
      db.upstreamAccount.findFirst.mockResolvedValue({ id: 'ua-1' } as never);
      db.upstreamAccount.delete.mockRejectedValue(recordNotFound());

      const error = await refusal(service.unlink(ME, Upstream.Steam, SCOPE));

      expect(error.getStatus()).toBe(Http.NotFound);
      expect(error.code).toBe(UpstreamAccountErrorCode.NotFound);
      expect(emit).not.toHaveBeenCalled();
    });

    it('lets any other failure through', async () => {
      const failure = new Error('connection reset');
      db.upstreamAccount.findFirst.mockResolvedValue({ id: 'ua-1' } as never);
      db.upstreamAccount.delete.mockRejectedValue(failure);

      await expect(service.unlink(ME, Upstream.Steam, SCOPE)).rejects.toBe(failure);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('stores the account and emits upstream_account.linked with it', async () => {
      const row = account();
      db.upstreamAccount.create.mockResolvedValue(row);

      await expect(service.create(STEAM_INPUT)).resolves.toBe(row);

      expect(db.upstreamAccount.create).toHaveBeenCalledWith({
        data: { ...STEAM_INPUT, displayName: null },
      });
      expect(emit).toHaveBeenCalledTimes(1);
      const [name, event] = emit.mock.calls[0];
      expect(name).toBe('upstream_account.linked');
      expect(event).toBeInstanceOf(UpstreamAccountLinkedEvent);
      expect(event).toMatchObject({
        before: null,
        after: snapshotOf(row),
        subject: ResourceType.UpstreamAccount,
        subjectId: row.id,
        action: 'create',
      });
      expect(event.after).not.toHaveProperty('createdAt');
    });

    it.each([
      ['the index name', uniqueViolation({ index: 'upstream_accounts_user_id_upstream_key' })],
      ['the raw columns', uniqueViolation({ fields: ['user_id', 'upstream'] })],
      ['the Prisma fields', uniqueViolation({ target: ['userId', 'upstream'] })],
    ])('answers UPSTREAM_ACCOUNT_ALREADY_LINKED on the user-and-upstream index, named by %s', async (_, violation) => {
      db.upstreamAccount.create.mockRejectedValue(violation);

      const error = await refusal(service.create(STEAM_INPUT));

      expect(error.getStatus()).toBe(Http.Conflict);
      expect(error.code).toBe(UpstreamAccountErrorCode.AlreadyLinked);
      expect(error.code).toBe('UPSTREAM_ACCOUNT_ALREADY_LINKED');
      expect(db.upstreamAccount.findUnique).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it.each([
      ['the index name', uniqueViolation({ index: 'upstream_accounts_verified_external_id' })],
      ['the raw columns', uniqueViolation({ fields: ['upstream', 'external_id'] })],
      ['the Prisma fields', uniqueViolation({ target: ['upstream', 'externalId'] })],
    ])(
      'answers UPSTREAM_ACCOUNT_TAKEN on the verified external id index, named by %s, naming no one',
      async (_, violation) => {
        db.upstreamAccount.create.mockRejectedValue(violation);

        const error = await refusal(service.create(STEAM_INPUT));

        expect(error.getStatus()).toBe(Http.Conflict);
        expect(error.code).toBe(UpstreamAccountErrorCode.Taken);
        expect(error.code).toBe('UPSTREAM_ACCOUNT_TAKEN');
        // Neither the caller, nor the account, nor whoever holds it (#935).
        const body = JSON.stringify(error.getResponse());
        expect(body).not.toContain(ME);
        expect(body).not.toContain(STEAM_ID);
        expect(emit).not.toHaveBeenCalled();
      },
    );

    // `meta.target` is empty on Prisma 7.10 with the pg adapter
    // (prisma/prisma#28953), so an unnamed violation is settled by reading
    // whether the user now has an account at that upstream.
    describe('a violation whose constraint cannot be named', () => {
      it('answers UPSTREAM_ACCOUNT_ALREADY_LINKED when the user now has an account at that upstream', async () => {
        db.upstreamAccount.create.mockRejectedValue(uniqueViolationWithoutMeta());
        db.upstreamAccount.findUnique.mockResolvedValue({ id: 'ua-2' } as never);

        const error = await refusal(service.create(STEAM_INPUT));

        expect(error.code).toBe(UpstreamAccountErrorCode.AlreadyLinked);
        expect(db.upstreamAccount.findUnique).toHaveBeenCalledWith({
          where: { userId_upstream: { userId: ME, upstream: Upstream.Steam } },
          select: { id: true },
        });
      });

      it('answers UPSTREAM_ACCOUNT_TAKEN when the user has none', async () => {
        db.upstreamAccount.create.mockRejectedValue(uniqueViolationWithoutMeta());
        db.upstreamAccount.findUnique.mockResolvedValue(null);

        const error = await refusal(service.create(STEAM_INPUT));

        expect(error.code).toBe(UpstreamAccountErrorCode.Taken);
      });
    });

    it('lets a violation of any other unique through, and logs which one', async () => {
      const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const violation = uniqueViolation({ index: 'upstream_accounts_pkey' });
      db.upstreamAccount.create.mockRejectedValue(violation);

      await expect(service.create(STEAM_INPUT)).rejects.toBe(violation);
      expect(emit).not.toHaveBeenCalled();
      expect(db.upstreamAccount.findUnique).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('upstream_accounts_pkey'), violation.stack);

      logError.mockRestore();
    });

    it('lets a failure that is not a unique violation through, with no re-read and no event', async () => {
      const failure = new Error('connection reset');
      db.upstreamAccount.create.mockRejectedValue(failure);

      await expect(service.create(STEAM_INPUT)).rejects.toBe(failure);
      expect(db.upstreamAccount.findUnique).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('assertNotLinked', () => {
    // Starting a link while linked is refused before the user is sent to the
    // upstream, with the same answer the insert would give (#935).
    it('answers UPSTREAM_ACCOUNT_ALREADY_LINKED when the user has an account at that upstream', async () => {
      db.upstreamAccount.findUnique.mockResolvedValue({ id: 'ua-1' } as never);

      const error = await refusal(service.assertNotLinked(ME, Upstream.Steam));

      expect(error.getStatus()).toBe(Http.Conflict);
      expect(error.code).toBe(UpstreamAccountErrorCode.AlreadyLinked);
      expect(db.upstreamAccount.findUnique).toHaveBeenCalledWith({
        where: { userId_upstream: { userId: ME, upstream: Upstream.Steam } },
        select: { id: true },
      });
    });

    it('resolves when the user has no account at that upstream', async () => {
      db.upstreamAccount.findUnique.mockResolvedValue(null);

      await expect(service.assertNotLinked(ME, Upstream.Steam)).resolves.toBeUndefined();
    });
  });

  describe('privacyPolicy', () => {
    // The policy a link shows, chosen by the read `GET /api/privacy-policy`
    // makes, so the user sees the same policy in both (#934).
    it('reads the policy for the user, and answers its address, language and date', async () => {
      await expect(service.privacyPolicy(ME, 'fr-CH, fr;q=0.9')).resolves.toEqual({
        url: '/api/privacy-policy',
        language: 'de',
        updatedAt: '2026-11-18T00:00:00.000Z',
      });

      expect(readFor).toHaveBeenCalledWith({ userId: ME, acceptLanguage: 'fr-CH, fr;q=0.9' });
    });
  });
});
