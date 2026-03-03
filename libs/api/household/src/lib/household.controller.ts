import { Action, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { ClsService } from 'nestjs-cls';
import { from } from 'rxjs';
import { tap } from 'rxjs/operators';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { HouseholdService } from './household.service';

@UseGuards(PoliciesGuard)
@ApiTags('households')
@Controller('households')
export class HouseholdController {
  constructor(
    private readonly householdService: HouseholdService,
    private readonly cls: ClsService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  @CheckPolicies((ability) => ability.can(Action.Read, ResourceType.Household))
  @Get()
  getHouseholdsForUser(@Query() pagination: PaginationQueryDto) {
    const userAbility = this.getUserAbility();
    const apiKeyAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return from(this.householdService.getHouseholdsForUser(pagination, userAbility, apiKeyAbility));
  }

  @CheckPolicies((ability) => ability.can(Action.Create, ResourceType.Household))
  @Post()
  create(@Session() session: UserSession, @Body() createHouseholdDto: CreateHouseholdDto) {
    return from(this.householdService.create(session.user.id, createHouseholdDto)).pipe(
      tap(() => this.cache.del(`bge:user:permissions:${session.user.id}`)),
    );
  }

  @CheckPolicies((ability) => ability.can(Action.Read, ResourceType.Household))
  @Get(':id')
  getById(@Param('id') id: string) {
    const userAbility = this.getUserAbility();
    const apiKeyAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return from(this.householdService.getHouseholdById(id, userAbility, apiKeyAbility));
  }

  @CheckPolicies((ability) => ability.can(Action.Update, ResourceType.Household))
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateHouseholdDto: UpdateHouseholdDto) {
    const userAbility = this.getUserAbility();
    const apiKeyAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return from(this.householdService.updateHousehold(id, updateHouseholdDto, userAbility, apiKeyAbility));
  }

  @CheckPolicies((ability) => ability.can(Action.Delete, ResourceType.Household))
  @Delete(':id')
  async delete(@Param('id') id: string) {
    const userAbility = this.getUserAbility();
    const apiKeyAbility = this.cls.get<AppAbility>('apiKeyAbility');

    return from(this.householdService.deleteHousehold(id, userAbility, apiKeyAbility));
  }

  private getUserAbility(): AppAbility {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    if (!userAbility) {
      throw new ForbiddenException('User ability not found in context.');
    }
    return userAbility;
  }
}
