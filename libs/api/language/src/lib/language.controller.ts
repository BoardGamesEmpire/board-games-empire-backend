import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { LanguageService } from './language.service';

@ApiTags('languages')
@UseGuards(AuthGuard)
@Controller('languages')
export class LanguageController {
  constructor(private languageService: LanguageService) {}

  @Get()
  getLanguages() {
    return from(this.languageService.getLanguages()).pipe(map((languages) => ({ languages })));
  }

  @Get(':id')
  getLanguageById(@Param('id') id: string) {
    return from(this.languageService.getLanguageById(id)).pipe(map((language) => ({ language })));
  }
}
