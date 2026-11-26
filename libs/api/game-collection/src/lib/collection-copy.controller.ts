import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CollectionCopyService } from './collection-copy.service';
import {
  CollectionCopyListResponseDto,
  CollectionCopyMessageResponseDto,
  CollectionRevisionListResponseDto,
  CreateCollectionCopyDto,
  RemoveCollectionCopyQueryDto,
  UpdateCollectionCopyDto,
} from './dto';

const ENTRY_NOT_FOUND = 'Collection entry not found, or not yours (code COLLECTION_ENTRY_NOT_FOUND)';
const COPY_NOT_FOUND = 'the copy not found on it (code COLLECTION_COPY_NOT_FOUND)';

/**
 * The copies of a collection entry, on the entry owner's routes (#1231). Every
 * route, the writes included, answers only the entry's owner: anyone else
 * gets `COLLECTION_ENTRY_NOT_FOUND`, whatever their grants, because each
 * answer carries the copy's price, value, acquisition and note. Each write is
 * an update of the entry, held to its conditions; removing the entry's last
 * owned copy removes the entry, and needs permission to remove it too
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
      'Every copy, those you removed or took back included, oldest first; a copy taken back carries `retractedAt`. ' +
      'Only the entry’s owner sees them here: where and when a ' +
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
      'to an entry you removed adds the game back, and the offers its removal paused in events count again. ' +
      'Send a `clientRequestId` to make a retry safe: a repeat answers the copy the first request added. ' +
      'Only the entry’s owner can add one: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiResponse({ status: Http.Created, type: CollectionCopyMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A condition on a digital copy (code COLLECTION_CONDITION_DIGITAL), an acquisition on a day that hasn’t begun anywhere on Earth yet ' +
      '(code COLLECTION_DATE_IN_FUTURE, with `field`), a price in a currency that is not an ISO 4217 code ' +
      '(code COLLECTION_CURRENCY_UNKNOWN), a release of another platform game ' +
      '(code COLLECTION_RELEASE_PLATFORM_MISMATCH), or a malformed body',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: `${ENTRY_NOT_FOUND}, or the release not found, including one deleted while the add ran (code GAME_RELEASE_NOT_FOUND)`,
  })
  @ApiResponse({
    status: Http.Conflict,
    description: 'You already own the most copies the entry holds (code COLLECTION_COPY_LIMIT_REACHED)',
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
      'removed, its removal date and reason. Only the entry’s owner can correct one: anyone else is told the entry was ' +
      'not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionCopyMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'No field to change, a condition on a digital copy (code COLLECTION_CONDITION_DIGITAL), a date on a ' +
      'day that hasn’t begun anywhere on Earth yet (code COLLECTION_DATE_IN_FUTURE, with `field` naming ' +
      'which), a removal before the acquisition (code COLLECTION_DATE_ORDER), a price in a currency that is ' +
      'not an ISO 4217 code (code COLLECTION_CURRENCY_UNKNOWN), a release of another platform game ' +
      '(code COLLECTION_RELEASE_PLATFORM_MISMATCH), or a malformed body',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description:
      `${ENTRY_NOT_FOUND}, the copy not found on it or taken back (code COLLECTION_COPY_NOT_FOUND), or the release not found ` +
      '(code GAME_RELEASE_NOT_FOUND)',
  })
  @ApiResponse({
    status: Http.Conflict,
    description: 'A removal date or reason for a copy you have not removed (code COLLECTION_COPY_NOT_REMOVED)',
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
      'The copy is marked removed, dated `removedOn`, or when none is given, today (UTC), or the copy’s ' +
      'acquisition day when it is later, optionally with a reason. Removing the last copy you own removes the game from your collection, with that reason, as ' +
      'removing the entry does: in every event that offers it, nominations of the game that await an outcome ' +
      'pause, and the game leaves the lineup of every date still ahead. That needs permission to remove the ' +
      'entry too. Only the entry’s owner can remove one: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionCopyMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'A removal date on a day that hasn’t begun anywhere on Earth yet (code COLLECTION_DATE_IN_FUTURE, with `field`), or before the copy ' +
      'was acquired ' +
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
    description: `${ENTRY_NOT_FOUND}, or the copy not found on it, already removed or taken back (code COLLECTION_COPY_NOT_FOUND)`,
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Delete(':copyId')
  removeCopy(@Param('id') id: string, @Param('copyId') copyId: string, @Query() query: RemoveCollectionCopyQueryDto) {
    return from(this.copies.remove(id, copyId, query)).pipe(
      map((copy) => ({ copy, message: t('success.game_collection.copy_removed') })),
    );
  }

  @ApiOperation({
    summary: 'Take back a copy you never had',
    description:
      'Says the copy never existed, as when it was added by mistake: it counts as neither owned nor removed, ' +
      'leaves the entry’s quantity and its copies on the entry, and only the copies list shows it, with ' +
      '`retractedAt`. A copy taken back can’t be corrected, removed or restored until the take-back is undone. ' +
      'The last copy you own can’t be taken back: add the right copy first, or remove the game. Only the ' +
      'entry’s owner can take one back: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionCopyMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: `${ENTRY_NOT_FOUND}, or the copy not found on it, or taken back already (code COLLECTION_COPY_NOT_FOUND)`,
  })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The last copy you own of the game (code COLLECTION_LAST_COPY)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @HttpCode(Http.Ok)
  @Post(':copyId/retraction')
  takeBackCopy(@Param('id') id: string, @Param('copyId') copyId: string) {
    return from(this.copies.takeBack(id, copyId)).pipe(
      map((copy) => ({ copy, message: t('success.game_collection.copy_taken_back') })),
    );
  }

  @ApiOperation({
    summary: 'Undo taking back a copy',
    description:
      'The copy counts again, as a copy you own or one you removed, whichever it was. A copy you own on a game ' +
      'you had removed adds the game back to your collection, and the offers its removal paused in events count ' +
      'again. Only the entry’s owner can undo one: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionCopyMessageResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({
    status: Http.NotFound,
    description: `${ENTRY_NOT_FOUND}, or the copy not found on it (code COLLECTION_COPY_NOT_FOUND)`,
  })
  @ApiResponse({
    status: Http.Conflict,
    description: 'A copy you have not taken back (code COLLECTION_COPY_NOT_TAKEN_BACK)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @Delete(':copyId/retraction')
  undoTakeBackCopy(@Param('id') id: string, @Param('copyId') copyId: string) {
    return from(this.copies.undoTakeBack(id, copyId)).pipe(
      map((copy) => ({ copy, message: t('success.game_collection.copy_take_back_undone') })),
    );
  }

  @ApiOperation({
    summary: 'List the revisions of a copy',
    description:
      'Each edit, removal or restore of a copy first keeps what it said before as a revision. Newest first, ' +
      'each in the shape you read the copy. An edition deleted since reads as none. A copy taken back keeps its ' +
      'revisions readable. Only the ' +
      'entry’s owner sees them: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionRevisionListResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: `${ENTRY_NOT_FOUND}, or ${COPY_NOT_FOUND}` })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.GameCollection))
  @Get(':copyId/revisions')
  listRevisions(@Param('id') id: string, @Param('copyId') copyId: string) {
    return from(this.copies.listRevisions(id, copyId)).pipe(map((revisions) => ({ revisions })));
  }

  @ApiOperation({
    summary: 'Restore a revision of a copy',
    description:
      'Writes a revision’s values back to the copy, and keeps what the copy says now as a revision of its own, so ' +
      'a restore can be undone the same way. An edition deleted since is restored as none. Restoring a revision ' +
      'from before a removal makes the copy yours again, and adds the game back to your collection if it had ' +
      'left, and the offers its removal paused in events count again. Restoring a removal of the last copy you ' +
      'own removes the game, as removing the copy does, and needs permission to remove the entry too. Only the ' +
      'entry’s owner can restore one: anyone else is told the entry was not found.',
  })
  @ApiParam({ name: 'id', type: String, description: 'The collection entry' })
  @ApiParam({ name: 'copyId', type: String })
  @ApiParam({ name: 'revisionId', type: String })
  @ApiResponse({ status: Http.Ok, type: CollectionCopyMessageResponseDto })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'Values a copy may no longer hold: a condition on a digital copy (code COLLECTION_CONDITION_DIGITAL), a ' +
      'removal before the acquisition (code COLLECTION_DATE_ORDER), or a price in a currency that is not an ISO ' +
      '4217 code (code COLLECTION_CURRENCY_UNKNOWN)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description: 'Insufficient permissions, including no permission to remove the entry with its last copy',
  })
  @ApiResponse({
    status: Http.NotFound,
    description:
      `${ENTRY_NOT_FOUND}, ${COPY_NOT_FOUND} or taken back, or the revision not found on the copy, including one whose stored ` +
      'values can’t be read back (code COLLECTION_REVISION_NOT_FOUND)',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.GameCollection))
  @HttpCode(Http.Ok)
  @Post(':copyId/revisions/:revisionId/restore')
  restoreRevision(@Param('id') id: string, @Param('copyId') copyId: string, @Param('revisionId') revisionId: string) {
    return from(this.copies.restore(id, copyId, revisionId)).pipe(
      map((copy) => ({ copy, message: t('success.game_collection.copy_restored') })),
    );
  }
}
