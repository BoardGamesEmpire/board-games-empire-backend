import { Action } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { HouseholdService } from './household.service';

@UseGuards(PoliciesGuard)
@ApiTags('households')
@Controller('households')
export class HouseholdController {
  constructor(private householdService: HouseholdService) {}

  @CheckPolicies((ability) => ability.can(Action.Read, 'Household'))
  @Get()
  async getHouseholdsForUser(@Query() pagination: PaginationQueryDto) {
    return this.householdService.getHouseholdsForUser(pagination);
  }

  @CheckPolicies((ability) => ability.can(Action.Create, 'Household'))
  @Post()
  async create(@Session() session: UserSession, @Body() createHouseholdDto: CreateHouseholdDto) {
    return this.householdService.create(session.user.id, createHouseholdDto);
  }

  @CheckPolicies((ability) => ability.can(Action.Read, 'Household'))
  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.householdService.getHouseholdById(id);
  }

  @CheckPolicies((ability) => ability.can(Action.Update, 'Household'))
  @Patch(':id')
  async update(@Param('id') id: string, @Body() updateHouseholdDto: UpdateHouseholdDto) {
    return this.householdService.updateHousehold(id, updateHouseholdDto);
  }

  @CheckPolicies((ability) => ability.can(Action.Delete, 'Household'))
  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.householdService.deleteHousehold(id);
  }
}
