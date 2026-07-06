import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CreateFriendRequestDto, ListFriendshipsQueryDto, RespondFriendRequestDto } from './dto';
import { FriendshipService } from './friendship.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('friendships')
@Controller('friendships')
export class FriendshipController {
  constructor(private readonly friendshipService: FriendshipService) {}

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Friendship))
  @Post()
  create(@Body() createFriendRequestDto: CreateFriendRequestDto) {
    return from(this.friendshipService.create(createFriendRequestDto)).pipe(
      map((friendship) => ({ message: 'Friend request sent successfully', friendship })),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Friendship))
  @Get()
  list(@Query() query: ListFriendshipsQueryDto) {
    return from(this.friendshipService.listForUser(query)).pipe(map((friendships) => ({ friendships })));
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Friendship))
  @Get('requests')
  listRequests(@Query() query: ListFriendshipsQueryDto) {
    return from(this.friendshipService.listIncomingRequests(query)).pipe(map((requests) => ({ requests })));
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Friendship))
  @Patch(':id')
  respond(@Param('id') id: string, @Body() respondFriendRequestDto: RespondFriendRequestDto) {
    return from(this.friendshipService.respond(id, respondFriendRequestDto.status)).pipe(
      map((friendship) => ({ message: `Friendship ${respondFriendRequestDto.status.toLowerCase()}`, friendship })),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.Friendship))
  @Delete(':id')
  remove(@Param('id') id: string) {
    return from(this.friendshipService.remove(id)).pipe(
      map(() => ({ message: `Friendship with ID ${id} removed successfully` })),
    );
  }
}
