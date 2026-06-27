import { Controller, Get, Header, Query, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { StreamMediaQueryDto } from './dto';
import { MediaObjectService } from './media-object.service';

/**
 * Sessionless byte streaming for signed GET URLs. `@AllowAnonymous()`
 * opts out of the global AuthGuard; no PoliciesGuard (the HMAC signature is the
 * authorization). `nosniff` + a server-chosen disposition mitigate stored XSS.
 */
@ApiTags('media')
@Controller('media-stream')
export class MediaStreamController {
  constructor(private readonly media: MediaObjectService) {}

  @AllowAnonymous()
  @Header('X-Content-Type-Options', 'nosniff')
  @Get()
  stream(@Query() query: StreamMediaQueryDto) {
    return from(this.media.getVerifiedStream(query)).pipe(
      map(
        ({ stream, contentType, contentDisposition }) =>
          new StreamableFile(stream, { type: contentType, disposition: contentDisposition }),
      ),
    );
  }
}
