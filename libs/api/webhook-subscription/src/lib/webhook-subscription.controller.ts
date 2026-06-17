import { Action, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { CreateWebhookSubscriptionDto, UpdateWebhookSubscriptionDto } from '@bge/webhooks';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { ClsService } from 'nestjs-cls';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { WebhookSubscriptionService } from './webhook-subscription.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('webhooks')
@UseGuards(PoliciesGuard)
@Controller('webhooks/subscriptions')
export class WebhookSubscriptionController {
  private readonly logger = new Logger(WebhookSubscriptionController.name);

  constructor(
    private readonly subscriptions: WebhookSubscriptionService,
    private readonly cls: ClsService,
  ) {}

  @ApiOperation({ summary: 'Create a webhook subscription' })
  @ApiResponse({ status: Http.Created, description: 'Subscription created' })
  @ApiResponse({ status: Http.Forbidden, description: 'No read access to the requested events' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.WebhookSubscription))
  @Post()
  create(@Session() session: UserSession, @Body() dto: CreateWebhookSubscriptionDto) {
    return from(this.subscriptions.create(session.user.id, dto, this.getAbilities())).pipe(
      tap((sub) => this.logger.log(`Webhook subscription ${sub.id} created by user ${session.user.id}`)),
      map((subscription) => ({ message: 'Webhook subscription created', subscription })),
    );
  }

  @ApiOperation({ summary: 'List your webhook subscriptions' })
  @ApiResponse({ status: Http.Ok, description: 'Subscriptions retrieved' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.WebhookSubscription))
  @Get()
  list(@Session() session: UserSession) {
    return from(this.subscriptions.list(session.user.id)).pipe(map((subscriptions) => ({ subscriptions })));
  }

  @ApiOperation({ summary: 'Get a webhook subscription by ID' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Subscription retrieved' })
  @ApiResponse({ status: Http.NotFound, description: 'Subscription not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.WebhookSubscription))
  @Get(':id')
  getById(@Param('id') id: string, @Session() session: UserSession) {
    return from(this.subscriptions.getById(id, session.user.id)).pipe(map((subscription) => ({ subscription })));
  }

  @ApiOperation({ summary: 'Update a webhook subscription' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Subscription updated' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.WebhookSubscription))
  @Patch(':id')
  update(@Param('id') id: string, @Session() session: UserSession, @Body() dto: UpdateWebhookSubscriptionDto) {
    return from(this.subscriptions.update(id, session.user.id, dto, this.getAbilities())).pipe(
      map((subscription) => ({ message: `Webhook subscription ${id} updated`, subscription })),
    );
  }

  @ApiOperation({ summary: 'Disable a webhook subscription' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Subscription disabled' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.WebhookSubscription))
  @Post(':id/disable')
  disable(@Param('id') id: string, @Session() session: UserSession) {
    return from(this.subscriptions.disable(id, session.user.id)).pipe(
      map((subscription) => ({ message: `Webhook subscription ${id} disabled`, subscription })),
    );
  }

  @ApiOperation({ summary: 'Re-activate a disabled or failed subscription' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Subscription re-activated' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.WebhookSubscription))
  @Post(':id/reactivate')
  reactivate(@Param('id') id: string, @Session() session: UserSession) {
    return from(this.subscriptions.reactivate(id, session.user.id, this.getAbilities())).pipe(
      map((subscription) => ({ message: `Webhook subscription ${id} re-activated`, subscription })),
    );
  }

  @ApiOperation({ summary: 'Delete a webhook subscription' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Subscription deleted' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.WebhookSubscription))
  @Delete(':id')
  remove(@Param('id') id: string, @Session() session: UserSession) {
    return from(this.subscriptions.remove(id, session.user.id)).pipe(
      tap(() => this.logger.log(`Webhook subscription ${id} deleted by user ${session.user.id}`)),
      map(() => ({ message: `Webhook subscription ${id} deleted` })),
    );
  }

  private getAbilities(): AppAbility[] {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    const apiAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return [userAbility, apiAbility].filter(Boolean);
  }
}
