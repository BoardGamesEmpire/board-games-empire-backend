import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import type { UploadedMediaFile } from './dto';
import {
  AttachMediaDto,
  ContributeMediaDto,
  DetachMediaDto,
  toMediaContributionResponse,
  toMediaObjectResponse,
} from './dto';
import { MediaLinkService } from './link/link.service';
import { MediaContributionService } from './media-contribution.service';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES } from './media-mime.policy';
import { MediaObjectService } from './media-object.service';
import { MulterExceptionFilter } from './multer-exception.filter';

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
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
  @UseFilters(MulterExceptionFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      fileFilter: (
        _req: unknown,
        file: { mimetype: string },
        cb: (error: Error | null, acceptFile: boolean) => void,
      ) =>
        ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)
          ? cb(null, true)
          : cb(new UnsupportedMediaTypeException(`Unsupported media type: ${file.mimetype}`), false),
    }),
  )
  @Post()
  upload(@UploadedFile() file?: UploadedMediaFile) {
    if (!file) {
      throw new BadRequestException('A file is required under the "file" field');
    }

    return from(this.media.upload(file)).pipe(map((media) => ({ media: toMediaObjectResponse(media) })));
  }

  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.MediaObject))
  @Get()
  list(@Query() pagination: PaginationQueryDto) {
    return from(this.media.list(pagination)).pipe(map((items) => ({ media: items.map(toMediaObjectResponse) })));
  }

  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.MediaObject))
  @Get(':id')
  getById(@Param('id') id: string) {
    return from(this.media.findById(id)).pipe(map((media) => ({ media: toMediaObjectResponse(media) })));
  }

  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.MediaObject))
  @Get(':id/url')
  signedUrl(@Param('id') id: string) {
    return from(this.media.createSignedUrl(id)).pipe(map((url) => ({ url })));
  }

  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.MediaObject))
  @Delete(':id')
  remove(@Param('id') id: string) {
    return from(this.media.delete(id)).pipe(
      map((media) => ({ message: `Media object ${id} deleted successfully`, media: toMediaObjectResponse(media) })),
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
