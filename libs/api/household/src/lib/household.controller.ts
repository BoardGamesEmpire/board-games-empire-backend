import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthGuard, Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { HouseholdService } from './household.service';

@UseGuards(AuthGuard)
@ApiTags('households')
@Controller('households')
export class HouseholdController {
  constructor(private householdService: HouseholdService) {}

  @Get()
  async getHouseholds(@Session() session: UserSession) {
    return this.householdService.getHouseholdsForUser(session.user.id);
  }

  @Post()
  async create(@Session() session: UserSession, @Body() createHouseholdDto: CreateHouseholdDto) {
    return this.householdService.create(session.user.id, createHouseholdDto);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.householdService.getHouseholdById(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() updateHouseholdDto: UpdateHouseholdDto) {
    return this.householdService.updateHousehold(id, updateHouseholdDto);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.householdService.deleteHousehold(id);
  }
}
