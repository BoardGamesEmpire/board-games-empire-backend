import { GameAdditionMode, NominationStatus } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { t } from '@bge/i18n';
import { Http } from '@status/codes';
import type { NominationStatusRefusalCode, RefusedAdditionMode } from './nomination-refusals';
import { directAddRefusal, nominationStatusRefusal } from './nomination-refusals';

/**
 * The sentence each status reads as, written out from the wording table rather
 * than read from the map under test, so a swapped entry fails here (#1114).
 */
const STATE_SENTENCES: [NominationStatus, I18nPath][] = [
  [NominationStatus.Open, 'errors.nomination.state.open'],
  [NominationStatus.AwaitingApproval, 'errors.nomination.state.awaiting_approval'],
  [NominationStatus.Approved, 'errors.nomination.state.decided'],
  [NominationStatus.Passed, 'errors.nomination.state.decided'],
  [NominationStatus.Failed, 'errors.nomination.state.decided'],
  [NominationStatus.QuorumNotMet, 'errors.nomination.state.decided'],
  [NominationStatus.Rejected, 'errors.nomination.state.decided'],
  [NominationStatus.Paused, 'errors.nomination.state.paused'],
  [NominationStatus.Withdrawn, 'errors.nomination.state.withdrawn'],
];

const CODES: NominationStatusRefusalCode[] = [
  'NOMINATION_NOT_WITHDRAWABLE',
  'NOMINATION_NOT_OPEN',
  'NOMINATION_NOT_RESOLVABLE',
  'NOMINATION_NOT_AWAITING_APPROVAL',
];

describe('nominationStatusRefusal', () => {
  it('has a row for every status', () => {
    expect(STATE_SENTENCES.map(([status]) => status).sort()).toEqual(Object.values(NominationStatus).sort());
  });

  // The message is a whole sentence for the status, never the enum's name
  // dropped into a frame; the status itself stays a field a client can
  // branch on (#1114).
  describe.each(CODES)('%s', (code) => {
    it.each(STATE_SENTENCES)('words %s as a whole sentence and keeps it as a field (#1114)', (status, key) => {
      const refusal = nominationStatusRefusal(code, status);

      expect(refusal.getStatus()).toBe(Http.BadRequest);
      expect(refusal.getResponse()).toMatchObject({ code, status, message: t(key) });
    });
  });
});

describe('directAddRefusal', () => {
  // A mode that chooses games by nomination tells the actor to nominate
  // instead, and keeps the mode as a field (#1114).
  it.each<[RefusedAdditionMode, I18nPath]>([
    [GameAdditionMode.RequiresVote, 'errors.nomination.direct_add.requires_vote'],
    [GameAdditionMode.HostApproval, 'errors.nomination.direct_add.host_approval'],
  ])('refuses a direct add under %s with 403 GAME_ADDITION_NOT_DIRECT, the mode as a field (#1114)', (mode, key) => {
    const refusal = directAddRefusal(mode);

    expect(refusal.getStatus()).toBe(Http.Forbidden);
    expect(refusal.getResponse()).toMatchObject({ code: 'GAME_ADDITION_NOT_DIRECT', mode, message: t(key) });
  });
});
