import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { UserProfileEnvelopeDto } from '../dto/user-profile.response';
import type { UserProfileView } from './profile-view';
import { UserProfileService } from './user-profile.service';

const READ_DESCRIPTION =
  'A profile is readable by its owner, by their accepted friends when its reach admits friends, and by every ' +
  'signed-in user when it is `Public`. Staff read every profile. A profile the caller cannot read answers 404, ' +
  'as a user with no profile does. Dietary restrictions, accessibility needs, reach and searchable are served ' +
  "to the profile's owner alone, and are absent for anyone else, staff included. See #819.";

@ApiTags('users')
@UseGuards(PoliciesGuard)
@Controller('users')
export class UserProfileController {
  constructor(private readonly userProfileService: UserProfileService) {}

  // Declared before `:id/profile`, so `/users/me/profile` is never read as the
  // profile of a user whose id is "me".
  @ApiOperation({ summary: "Read the caller's own profile", description: READ_DESCRIPTION })
  @ApiResponse({ status: Http.Ok, type: UserProfileEnvelopeDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'The caller has no profile' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.UserProfile))
  @Get('me/profile')
  getOwnProfile(): Observable<{ profile: UserProfileView }> {
    return from(this.userProfileService.getOwnProfile()).pipe(map((profile) => ({ profile })));
  }

  @ApiOperation({ summary: "Read a user's profile", description: READ_DESCRIPTION })
  @ApiParam({ name: 'id', type: String, description: "The profile owner's user id" })
  @ApiResponse({ status: Http.Ok, type: UserProfileEnvelopeDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'No profile the caller can read' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.UserProfile))
  @Get(':id/profile')
  getProfile(@Param('id') id: string): Observable<{ profile: UserProfileView }> {
    return from(this.userProfileService.getProfile(id)).pipe(map((profile) => ({ profile })));
  }
}
