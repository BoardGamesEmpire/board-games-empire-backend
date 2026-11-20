import { Auditable, AuditExclude } from '@bge/actor-context';
import type { UpstreamAccount } from '@bge/database';
import { ResourceType, Upstream } from '@bge/database';
import { Reflector } from '@nestjs/core';
import {
  UpstreamAccountLinkedEvent,
  upstreamAccountSnapshot,
  UpstreamAccountUnlinkedEvent,
} from './upstream-account.events';

const row: UpstreamAccount = {
  id: 'ua-1',
  userId: 'user-1',
  upstream: Upstream.Steam,
  externalId: '76561197960287930',
  displayName: null,
  profileUrl: 'https://steamcommunity.com/profiles/76561197960287930',
  verified: true,
  createdAt: new Date('2026-11-19T10:00:00.000Z'),
  updatedAt: new Date('2026-11-19T11:00:00.000Z'),
};

describe('upstream account events (#935)', () => {
  // The audit row's own time covers when the row was made.
  it('snapshots every column but createdAt', () => {
    expect(upstreamAccountSnapshot(row)).toStrictEqual({
      id: 'ua-1',
      userId: 'user-1',
      upstream: Upstream.Steam,
      externalId: '76561197960287930',
      displayName: null,
      profileUrl: 'https://steamcommunity.com/profiles/76561197960287930',
      verified: true,
      updatedAt: new Date('2026-11-19T11:00:00.000Z'),
    });
  });

  it('audits a link as a create of the account', () => {
    const event = new UpstreamAccountLinkedEvent(upstreamAccountSnapshot(row), new Date());

    expect(UpstreamAccountLinkedEvent.eventName).toBe('upstream_account.linked');
    expect(event).toMatchObject({ action: 'create', subject: ResourceType.UpstreamAccount, subjectId: 'ua-1' });
  });

  it('audits an unlink as a delete of the account', () => {
    const event = new UpstreamAccountUnlinkedEvent(upstreamAccountSnapshot(row), new Date());

    expect(UpstreamAccountUnlinkedEvent.eventName).toBe('upstream_account.unlinked');
    expect(event).toMatchObject({ action: 'delete', subject: ResourceType.UpstreamAccount, subjectId: 'ua-1' });
  });

  // Unlinking deletes the SteamID and the profile address that carries it, as
  // the privacy policy says (#935), so no audit row keeps either. In-process
  // listeners still get both.
  it.each([UpstreamAccountLinkedEvent, UpstreamAccountUnlinkedEvent])(
    '%p leaves the external id and the profile address out of its audit row',
    (cls) => {
      const reflector = new Reflector();
      const denylist = reflector.get(AuditExclude, cls) ?? [];
      const audited = Object.fromEntries(
        Object.entries(upstreamAccountSnapshot(row)).filter(([key]) => !denylist.includes(key)),
      );

      expect(reflector.get(Auditable, cls)).not.toBe(false);
      expect(denylist).toEqual(['externalId', 'profileUrl']);
      expect(JSON.stringify(audited)).not.toContain(row.externalId);
    },
  );
});
