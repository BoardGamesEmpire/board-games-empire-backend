import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CollectionCopyService } from './collection-copy.service';
import {
  CollectionCopyListResponseDto,
  CollectionCopyMessageResponseDto,
  CreateCollectionCopyDto,
  RemoveCollectionCopyQueryDto,
  UpdateCollectionCopyDto,
} from './dto';

const ENTRY_NOT_FOUND = 'Collection entry not found, or not yours (code COLLECTION_ENTRY_NOT_FOUND)';

/**
 * The copies of a collection entry, on its owner's routes (#1231). Each write
 * is an update of the entry, held to its conditions; removing the entry's
 * last owned copy removes the entry, and needs permission to remove it too
 * (#1288).
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('game-collections')
// Must stay out of the response cache, as the entry routes do: the
// offline-first client writes then re-reads to reconcile local state.
@UseGuards(PoliciesGuard)
@Controller('game-collections/:id/copies')
export class CollectionCopyController {
  constructor(private readonly copies: CollectionCopyService) {}

  @ApiOperation({
    summary: 'List the copies of one of your collection entries',
    description:
      'Every copy, those you removed included, oldest first. Only the owner sees them here: where and when a ' +
      'copy was acquired, its price, value and note are yours alone.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiResponse({ status: Http.Ok, type: CollectionCopyListResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: ENTRY_NOT_FOUND })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get()
  listCopies(@Param('id') id: string) {
    return from(this.copies.list(id)).pipe(map((copies) => ({ copies })));
  }

  @ApiOperation({
    summary: 'Add a copy to one of your collection entries',
    description:
      'A copy of a game you already have, with its own edition, condition, acquisition and price. Adding a copy ' +
      'to an entry you removed adds the game back, and the offers its removal paused in events count again.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiResponse({ status: Http.Created, type: CollectionCopyMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A condition on a digital copy (code COLLECTION_CONDITION_DIGITAL), an acquisition after today ' +
      '(code COLLECTION_DATE_IN_FUTURE), a price in a currency that is not an ISO 4217 code ' +
      '(code COLLECTION_CURRENCY_UNKNOWN), a release of another platform game, or a malformed body',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: `${ENTRY_NOT_FOUND}, or the release not found` })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The entry already holds its most copies, removed ones included (code COLLECTION_COPY_LIMIT_REACHED)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Post()
  addCopy(@Param('id') id: string, @Body() dto: CreateCollectionCopyDto) {
    return from(this.copies.add(id, dto)).pipe(
      map((copy) => ({ copy, message: t('success.game_collection.copy_added') })),
    );
  }

  @ApiOperation({
    summary: 'Correct a copy (omitted fields preserved, null clears)',
    description:
      'Changes what a copy says: its edition, condition, acquisition, price, value or note, and for a copy you ' +
      'removed, its removal date and reason.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionCopyMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'No field to change, a condition on a digital copy (code COLLECTION_CONDITION_DIGITAL), a date after ' +
      'today (code COLLECTION_DATE_IN_FUTURE), a removal before the acquisition (code COLLECTION_DATE_ORDER), ' +
      'a price in a currency that is not an ISO 4217 code (code COLLECTION_CURRENCY_UNKNOWN), a release of ' +
      'another platform game, or a malformed body',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: `${ENTRY_NOT_FOUND}, the copy not found on it (code COLLECTION_COPY_NOT_FOUND), or the release not found`,
  })
  @ApiResponse({
    status: Http.Conflict,
    description: 'A removal date or reason for a copy you still own (code COLLECTION_COPY_OWNED)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Patch(':copyId')
  updateCopy(@Param('id') id: string, @Param('copyId') copyId: string, @Body() dto: UpdateCollectionCopyDto) {
    return from(this.copies.update(id, copyId, dto)).pipe(
      map((copy) => ({ copy, message: t('success.game_collection.copy_updated') })),
    );
  }

  @ApiOperation({
    summary: 'Remove a copy from your collection',
    description:
      'The copy is marked removed, dated `removedOn`, or today (UTC) when none is given, optionally with a ' +
      'reason. Removing the last copy you own removes the game from your collection, with that reason, as ' +
      'removing the entry does: in every event that offers it, nominations of the game that await an outcome ' +
      'pause, and the game leaves the lineup of every date still ahead. That needs permission to remove the ' +
      'entry too.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionCopyMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A removal date after today (code COLLECTION_DATE_IN_FUTURE), or before the copy was acquired ' +
      '(code COLLECTION_DATE_ORDER), or a malformed query: a reason that is not a removal reason, or a ' +
      '`removedOn` that is not a year, a month or a day',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Insufficient permissions, including no permission to remove the entry with its last copy',
  })
  @ApiResponse({
    status: Http.NotFound,
    description: `${ENTRY_NOT_FOUND}, or the copy not found on it, already removed (code COLLECTION_COPY_NOT_FOUND)`,
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Delete(':copyId')
  removeCopy(@Param('id') id: string, @Param('copyId') copyId: string, @Query() query: RemoveCollectionCopyQueryDto) {
    return from(this.copies.remove(id, copyId, query)).pipe(
      map((copy) => ({ copy, message: t('success.game_collection.copy_removed') })),
    );
  }
}
