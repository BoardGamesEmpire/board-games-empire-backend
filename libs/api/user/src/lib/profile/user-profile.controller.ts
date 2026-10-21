import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from, type Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { UpdateUserProfileDto } from '../dto/update-user-profile.dto';
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

  @ApiOperation({
    summary: "Edit the caller's own profile",
    description:
      'Every field is optional, and one left out is left as it is. An empty body answers 400. Reach takes ' +
      '`Public`, `Friends` or `Private`. The bio is Markdown, sanitized before it is stored. Blank or null clears ' +
      'an optional text field. The avatar cannot be changed here yet (#829), and the game tastes wait on #831: ' +
      'both are refused, as any unknown field is. Answers with the profile as its owner sees it. See #819.',
  })
  @ApiResponse({ status: Http.Ok, type: UserProfileEnvelopeDto })
  @ApiResponse({ status: Http.BadRequest, description: 'An empty body, or a field that fails validation' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'The caller has no profile' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.UserProfile))
  @Patch('me/profile')
  updateOwnProfile(@Body() dto: UpdateUserProfileDto): Observable<{ profile: UserProfileView }> {
    return from(this.userProfileService.updateOwnProfile(dto)).pipe(map((profile) => ({ profile })));
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
