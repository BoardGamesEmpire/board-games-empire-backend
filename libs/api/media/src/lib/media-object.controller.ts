import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto, NoCache, paginated, PaginatedResponseDto } from '@bge/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import type { UploadedMediaFile } from './dto';
import {
  AttachMediaDto,
  ContributeMediaDto,
  DetachMediaDto,
  MediaObjectResponseDto,
  toMediaContributionResponse,
  toMediaObjectResponse,
} from './dto';
import { StorageExceptionFilter } from './filters/storage-exception.filter';
import { MediaFileInterceptor } from './interceptors/media-file.interceptor';
import { MediaLinkService } from './link/link.service';
import { MediaContributionService } from './media-contribution.service';
import { MediaObjectService } from './media-object.service';
import { MulterExceptionFilter } from './multer-exception.filter';

const PaginatedMediaResponse = PaginatedResponseDto(MediaObjectResponseDto, 'media');

@ApiBearerAuth()
@ApiSecurity('api_key')
// Never response-cached (#530). `GET /media` is the caller's own media, so an
// upload, publish or delete followed by a list would be served the old page
// for the cache TTL, and `GET /media/:id` would keep serving an unpublished
// item's metadata to other callers for the same window.
@NoCache()
@UseGuards(PoliciesGuard)
@UseFilters(StorageExceptionFilter, MulterExceptionFilter)
@ApiTags('media')
@Controller('media')
export class MediaObjectController {
  constructor(
    private readonly media: MediaObjectService,
    private readonly contributions: MediaContributionService,
    private readonly link: MediaLinkService,
  ) {}

  @ApiResponse({ status: Http.PayloadTooLarge, description: 'File exceeds the size limit' })
  @ApiResponse({ status: Http.UnsupportedMediaType, description: 'Disallowed media type' })
  @ApiConsumes('multipart/form-data')
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.MediaObject))
  @UseInterceptors(MediaFileInterceptor)
  @Post()
  upload(@UploadedFile() file?: UploadedMediaFile) {
    if (!file) {
      throw new BadRequestException(t('errors.media_object.file_required'));
    }

    return from(this.media.upload(file)).pipe(map((media) => ({ media: toMediaObjectResponse(media) })));
  }

  @ApiResponse({ status: Http.PayloadTooLarge, description: 'File exceeds the size limit' })
  @ApiResponse({ status: Http.UnsupportedMediaType, description: 'Disallowed media type' })
  @ApiConsumes('multipart/form-data')
  @CheckPolicies(
    (ability) =>
      ability.can(Action.create, ResourceType.MediaObject) &&
      ability.can(Action.create, ResourceType.MediaContribution),
  )
  @UseInterceptors(MediaFileInterceptor)
  @Post('contribute')
  uploadAndContribute(@Body() dto: ContributeMediaDto, @UploadedFile() file?: UploadedMediaFile) {
    if (!file) {
      throw new BadRequestException(t('errors.media_object.file_required'));
    }

    return from(this.media.uploadAndContribute(file, dto)).pipe(
      map(({ media, contribution }) => ({
        media: toMediaObjectResponse(media),
        contribution: toMediaContributionResponse(contribution),
      })),
    );
  }

  @ApiOperation({
    summary: "List the caller's own media objects",
    description:
      'The media the caller owns, newest first. Media the caller may read but does not own, such as another ' +
      "user's public media, is not listed; it is read by id. Paginated: `?page=` (1-based) and `?limit=`, " +
      'with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`. See #230.',
  })
  @ApiResponse({ status: Http.Ok, type: PaginatedMediaResponse })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.MediaObject))
  @Get()
  list(@Query() pagination: DefaultPaginationQueryDto) {
    // Rows are mapped to their public shape before the envelope is built, so
    // `total` and the rows describe the same set — the mapper is a projection,
    // never a filter.
    return from(this.media.list(pagination)).pipe(
      map(({ rows, total }) =>
        paginated('media', { rows: rows.map(toMediaObjectResponse), total }, pagination, ResourceType.MediaObject),
      ),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.MediaObject))
  @Get(':id')
  getById(@Param('id') id: string) {
    return from(this.media.findById(id)).pipe(map((media) => ({ media: toMediaObjectResponse(media) })));
  }

  // Never response-cached: a signed URL lives as long as the cache TTL by
  // default, so a cached body hands out URLs that are already expiring (#528).
  // Deliberately kept beside the class-level opt-out, which covers this route
  // too: that one rests on the list and by-id reads, and this reason holds
  // whatever is decided for them.
  @NoCache()
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.MediaObject))
  @Get(':id/url')
  signedUrl(@Param('id') id: string) {
    return from(this.media.createSignedUrl(id)).pipe(map((url) => ({ url })));
  }

  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.MediaObject))
  @Delete(':id')
  remove(@Param('id') id: string) {
    return from(this.media.delete(id)).pipe(
      map((media) => ({ message: t('success.media_object.deleted', { id }), media: toMediaObjectResponse(media) })),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.MediaObject))
  @Post(':id/publish')
  publish(@Param('id') id: string) {
    return from(this.media.publish(id)).pipe(map((media) => ({ media: toMediaObjectResponse(media) })));
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.MediaObject))
  @Post(':id/unpublish')
  unpublish(@Param('id') id: string) {
    return from(this.media.unpublish(id)).pipe(map((media) => ({ media: toMediaObjectResponse(media) })));
  }

  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.MediaContribution))
  @Post(':id/contribute')
  contribute(@Param('id') id: string, @Body() dto: ContributeMediaDto) {
    return from(this.contributions.contribute(id, dto)).pipe(
      map((c) => ({ contribution: toMediaContributionResponse(c) })),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.MediaObject))
  @Post(':id/attach')
  attach(@Param('id') id: string, @Body() dto: AttachMediaDto) {
    const { subjectType, subjectId, title, caption, altText, thumbnailUrl, ...context } = dto;
    return from(
      this.link.attach(id, {
        subjectType,
        subjectId,
        presentation: { title, caption, altText, thumbnailUrl },
        context,
      }),
    ).pipe(map((attachment) => ({ attachment })));
  }

  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.MediaObject))
  @Post(':id/detach')
  detach(@Param('id') id: string, @Body() dto: DetachMediaDto) {
    return from(this.link.detach(id, dto)).pipe(map((result) => ({ detached: result.removed })));
  }
}
