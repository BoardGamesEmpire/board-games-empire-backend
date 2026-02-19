import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { LanguageService } from './language.service';

@ApiTags('languages')
@UseGuards(AuthGuard)
@Controller('languages')
export class LanguageController {
  constructor(private languageService: LanguageService) {}

  @Get()
  getLanguages() {
    return this.languageService.getLanguages();
  }

  @Get(':id')
  getLanguageById(@Param('id') id: string) {
    return this.languageService.getLanguageById(id);
  }
}
