import { sanitizeMarkdown } from '@bge/content-format';
import { Action, DatabaseService, isPrismaDependentRecordNotFoundError, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveActingUserIdOrNull } from '@bge/permissions';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import assert from 'node:assert';
import type { UpdateUserProfileDto } from '../dto/update-user-profile.dto';
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
   * profile, a friend's that reaches friends, a friend of a friend's that
   * reaches friends of friends (#496), and every `Public` one, or every
   * profile for staff. The reads by reach leave out a banned user's profile
   * (#840). A profile outside them answers 404, the same as a user
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

  /**
   * The acting user's edit to their own profile (#819). Answers with the
   * profile as its owner sees it.
   *
   * The write names the caller's own row and binds their `UserProfile` update
   * conditions to it, so it can never reach another user's profile. A row the
   * conditions exclude answers 403. No profile at all answers 404, which a
   * brand-new user can meet, since provisioning writes the profile after
   * signup, detached from it.
   */
  async updateOwnProfile(dto: UpdateUserProfileDto): Promise<UserProfileView> {
    assert(Object.keys(dto).length > 0, new BadRequestException(t('common.at_least_one_field')));

    const userId = this.abilityService.getActingUserId();
    const { bio, ...fields } = dto;

    try {
      const row = await this.db.userProfile.update({
        where: {
          userId,
          // eslint-disable-next-line no-restricted-syntax -- single-row write by user id, not a collection read
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.UserProfile, Action.update),
        },
        data: bio === undefined ? fields : { ...fields, bio: sanitizedBio(bio) },
        select: PROFILE_SELECT,
      });

      return toProfileView(row, true);
    } catch (error) {
      if (!isPrismaDependentRecordNotFoundError(error)) {
        throw error;
      }

      const exists = await this.db.userProfile.count({ where: { userId } });
      throw exists === 0
        ? new NotFoundException(t('errors.user.profile_not_found', { id: userId }))
        : new ForbiddenException(t('common.forbidden.update'));
    }
  }
}

/**
 * Sanitized as every stored description is (#714). A bio with nothing left
 * once sanitized is cleared. Only blank lines are cut from its start, since
 * leading spaces can be Markdown, such as an indented code block.
 */
function sanitizedBio(bio: string | null): string | null {
  if (bio === null) {
    return null;
  }

  const sanitized = sanitizeMarkdown(bio);
  return sanitized.trim() === '' ? null : sanitized.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}
