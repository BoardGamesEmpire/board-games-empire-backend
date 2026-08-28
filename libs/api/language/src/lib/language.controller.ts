import { PoliciesGuard } from '@bge/permissions';
import { paginated, paginatedEnvelopeSchema, PaginationMetaDto } from '@bge/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { LanguageQueryDto } from './dto/language-query.dto';
import { LanguageService } from './language.service';

@ApiTags('languages')
@UseGuards(PoliciesGuard)
// The list response references PaginationMetaDto by `$ref` and nothing else in
// this controller mentions it, so it needs registering explicitly.
@ApiExtraModels(PaginationMetaDto)
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
  @ApiResponse({ status: Http.Ok, description: 'Paginated languages', schema: paginatedEnvelopeSchema('languages') })
  @AllowAnonymous()
  @Get()
  getLanguages(@Query() languageDto: LanguageQueryDto) {
    return from(this.languageService.getLanguages(languageDto)).pipe(
      map((page) => paginated('languages', page, languageDto)),
    );
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @Get(':id')
  getLanguageById(@Param('id') id: string) {
    return from(this.languageService.getLanguageById(id)).pipe(map((language) => ({ language })));
  }
}
