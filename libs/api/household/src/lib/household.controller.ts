import { Action, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { ClsService } from 'nestjs-cls';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { HouseholdService } from './household.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@UseGuards(PoliciesGuard)
@ApiTags('households')
@Controller('households')
export class HouseholdController {
  private readonly logger = new Logger(HouseholdController.name);

  constructor(
    private readonly householdService: HouseholdService,
    private readonly cls: ClsService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {}

  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication required' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Household))
  @Get()
  getHouseholdsForUser(@Query() pagination: PaginationQueryDto) {
    const abilities = this.getAbilities();
    return from(
      this.householdService.getHouseholdsForUser(pagination, abilities.userAbility, abilities.apiAbility),
    ).pipe(map((households) => ({ households })));
  }

  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication required' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Household))
  @Post()
  create(@Session() session: UserSession, @Body() createHouseholdDto: CreateHouseholdDto) {
    return from(this.householdService.create(session.user.id, createHouseholdDto)).pipe(
      tap(() => this.cache.del(`bge:user:permissions:${session.user.id}`)),
      map((household) => ({ message: 'Household created successfully', household })),
    );
  }

  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication required' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Household))
  @Get(':id')
  getById(@Param('id') id: string) {
    this.logger.debug(`Fetching household with ID: ${id}`);

    const abilities = this.getAbilities();
    return from(this.householdService.getHouseholdById(id, abilities.userAbility, abilities.apiAbility)).pipe(
      map((household) => ({ household })),
    );
  }

  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication required' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Household))
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateHouseholdDto: UpdateHouseholdDto) {
    const abilities = this.getAbilities();
    return from(
      this.householdService.updateHousehold(id, updateHouseholdDto, abilities.userAbility, abilities.apiAbility),
    ).pipe(map((household) => ({ message: `Household with ID ${id} updated successfully`, household })));
  }

  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication required' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.Household))
  @Delete(':id')
  delete(@Param('id') id: string) {
    const abilities = this.getAbilities();
    return from(this.householdService.deleteHousehold(id, abilities.userAbility, abilities.apiAbility)).pipe(
      map((household) => ({ message: `Household with ID ${id} deleted successfully`, household })),
    );
  }

  private getAbilities() {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    const apiAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return { userAbility, apiAbility };
  }
}
