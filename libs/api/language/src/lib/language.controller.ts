import { PoliciesGuard } from '@bge/permissions';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { LanguageQueryDto } from './dto/language-query.dto';
import { LanguageService } from './language.service';

@ApiTags('languages')
@UseGuards(PoliciesGuard)
@Controller('languages')
export class LanguageController {
  constructor(private languageService: LanguageService) {}

  @AllowAnonymous()
  @Get()
  getLanguages(@Query() languageDto: LanguageQueryDto) {
    return from(this.languageService.getLanguages(languageDto)).pipe(map((languages) => ({ languages })));
  }

  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @Get(':id')
  getLanguageById(@Param('id') id: string) {
    return from(this.languageService.getLanguageById(id)).pipe(map((language) => ({ language })));
  }
}
