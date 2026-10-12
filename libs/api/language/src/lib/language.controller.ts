import { PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, CacheResponse, paginated, Unscoped } from '@bge/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { LanguageQueryDto } from './dto/language-query.dto';
import { LanguageService } from './language.service';

// Both reads opt into the response cache (#530). The catalogue is the same
// for every caller and seldom changes: an import or a gateway sync may add a
// language or tag, and the seed at each boot rewrites the curated rows, which
// a release may change. A read up to the TTL behind either is harmless.
@ApiTags('languages')
@UseGuards(PoliciesGuard)
@Controller('languages')
export class LanguageController {
  constructor(private languageService: LanguageService) {}

  @ApiOperation({
    summary: 'List languages',
    description:
      'Alphabetical by name, each with its tags. Filterable by `name` and `systemSupported`. Paginated: ' +
      '`?page=` (1-based) and `?limit=` (default 20, max 50), with a `pagination` envelope carrying ' +
      '`total`, `totalPages` and `hasMore`; `total` counts the rows matching the filters. See #230; the ' +
      'row shape is modelled in #402.',
  })
  @ApiPaginatedEnvelope('languages')
  @AllowAnonymous()
  @CacheResponse()
  @Get()
  getLanguages(@Query() languageDto: LanguageQueryDto) {
    return from(this.languageService.getLanguages(languageDto)).pipe(
      map((page) =>
        paginated(
          'languages',
          page,
          languageDto,
          Unscoped('the language catalogue is static installation data with no permissioned resource behind it'),
        ),
      ),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @CacheResponse()
  @Get(':id')
  getLanguageById(@Param('id') id: string) {
    return from(this.languageService.getLanguageById(id)).pipe(map((language) => ({ language })));
  }
}
