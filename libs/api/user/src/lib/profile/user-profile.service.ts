import { Action, DatabaseService, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull } from '@bge/permissions';
import { Injectable, NotFoundException } from '@nestjs/common';
import assert from 'node:assert';
import { PROFILE_SELECT, toProfileView, type UserProfileView } from './profile-view';

@Injectable()
export class UserProfileService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
  ) {}

  /**
   * A user's profile, as the caller may see it (#819).
   *
   * Read through the caller's `UserProfile` read conditions: their own
   * profile, a friend's that reaches friends, and every `Public` one, or every
   * profile for staff. A profile outside them answers 404, the same as a user
   * with no profile, as an event's read does, so the answer never tells the
   * caller that a profile exists and is shut to them.
   *
   * Searchable plays no part here: it decides whether a profile is offered to
   * search, not who may read it.
   */
  async getProfile(userId: string): Promise<UserProfileView> {
    const row = await this.db.userProfile.findUnique({
      where: {
        userId,
        // eslint-disable-next-line no-restricted-syntax -- single-row fetch by user id, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.UserProfile, Action.read),
      },
      select: PROFILE_SELECT,
    });

    assert(row, new NotFoundException(t('errors.user.profile_not_found', { id: userId })));

    // An actor with no user behind it owns no profile, so it is served the
    // shared fields rather than refused.
    return toProfileView(row, row.userId === resolveActingUserIdOrNull(this.abilityService));
  }

  /** The acting user's own profile, owner-only fields included. */
  async getOwnProfile(): Promise<UserProfileView> {
    return this.getProfile(this.abilityService.getActingUserId());
  }
}
