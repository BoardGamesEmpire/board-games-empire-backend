import { DatabaseService, Prisma, ResourceType, WebhookSubscriptionStatus } from '@bge/database';
import { I18nMessage, t } from '@bge/i18n';
import { AbilityService, type AppAbility } from '@bge/permissions';
import { EncryptionService } from '@bge/services';
import {
  CreateWebhookSubscriptionDto,
  UpdateWebhookSubscriptionDto,
  WebhookEventRegistry,
  WebhookVisibilityService,
  type WebhookEventType,
} from '@bge/webhooks';
import { accessibleBy } from '@casl/prisma';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';

/**
 * Placeholder returned in the `secret` field on reads. The stored secret is
 * encrypted at rest and the plaintext is revealed exactly once — at create, and
 * when rotated via update. Every other path returns this sentinel so the
 * ciphertext never leaves the service and stale plaintext is never re-served.
 */
export const WEBHOOK_SECRET_REDACTED = '__redacted__';

/** Subscription with its event-type rows hydrated — the shape every read/mutate path returns. */
type WebhookSubscriptionWithEventTypes = Prisma.WebhookSubscriptionGetPayload<{ include: { eventTypes: true } }>;

@Injectable()
export class WebhookSubscriptionService {
  private readonly logger = new Logger(WebhookSubscriptionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: WebhookEventRegistry,
    private readonly visibility: WebhookVisibilityService,
    private readonly encryption: EncryptionService,
    private readonly abilityService: AbilityService,
  ) {}

  /**
   * Creates a subscription owned by the acting user. The subscription is a
   * standing grant: we verify at create that the creator can currently `read`
   * (or the descriptor's stricter action) the subject of every requested event
   * type, and — when scoped — that they can read the named instance/household.
   * This is the coarse gate; per-event instance authorization still runs at
   * dispatch, so this rejects only subscriptions the creator could never
   * legitimately receive (including users denied via inverse permission once
   * #87 lands).
   *
   * The signing secret is stored encrypted (`EncryptionService`) and returned
   * in plaintext exactly once, here — the caller cannot retrieve it again.
   */
  async create(dto: CreateWebhookSubscriptionDto): Promise<WebhookSubscriptionWithEventTypes> {
    const userId = this.abilityService.getActingUserId();
    const abilities = this.requireAbilities(t('errors.webhook_subscription.forbidden_create'));

    this.assertTypesMatchResource(dto.eventTypes, dto.resourceType);
    this.assertCanReadSubjects(dto.eventTypes, abilities);

    if (dto.householdId) {
      await this.assertCanReadHousehold(dto.householdId, abilities);
    }

    if (dto.resourceId) {
      await this.assertCanReadInstance(dto.resourceType, dto.resourceId, abilities);
    }

    const plaintextSecret = dto.secret ?? this.generateSecret();
    const created = await this.db.webhookSubscription.create({
      data: {
        url: dto.url,
        secret: this.encryption.encrypt(plaintextSecret),
        resourceType: dto.resourceType,
        resourceId: dto.resourceId ?? null,
        household: dto.householdId ? { connect: { id: dto.householdId } } : undefined,
        status: WebhookSubscriptionStatus.Active,
        createdBy: { connect: { id: userId } },
        eventTypes: {
          create: dto.eventTypes.map((eventType) => ({ eventType })),
        },
      },
      include: { eventTypes: true },
    });

    this.logger.debug(`Created webhook subscription ${created.id} for user ${userId} on ${created.resourceType}`);

    return this.reveal(created, plaintextSecret);
  }

  /** Lists the caller's own subscriptions (excluding soft-deleted), secrets redacted. */
  async list(): Promise<WebhookSubscriptionWithEventTypes[]> {
    const userId = this.abilityService.getActingUserId();
    const subscriptions = await this.db.webhookSubscription.findMany({
      where: { createdById: userId, deletedAt: null },
      include: { eventTypes: true },
      orderBy: { createdAt: 'desc' },
    });
    return subscriptions.map((subscription) => this.redact(subscription));
  }

  async getById(id: string): Promise<WebhookSubscriptionWithEventTypes> {
    const userId = this.abilityService.getActingUserId();
    const subscription = await this.db.webhookSubscription.findFirst({
      where: { id, createdById: userId, deletedAt: null },
      include: { eventTypes: true },
    });

    if (!subscription) {
      throw new NotFoundException(t('errors.webhook_subscription.not_found', { id }));
    }

    return this.redact(subscription);
  }

  /**
   * Updates the mutable subset. Scope (`resourceType`/`resourceId`/
   * `householdId`) is immutable; changing `eventTypes` re-runs the read check
   * because it could widen the subject set. Rotating the secret re-encrypts and
   * reveals the new plaintext once (same contract as create); otherwise the
   * secret is redacted on the way out.
   */
  async update(id: string, dto: UpdateWebhookSubscriptionDto): Promise<WebhookSubscriptionWithEventTypes> {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const existing = await this.getById(id);

    if (dto.eventTypes) {
      const abilities = this.requireAbilities(t('errors.webhook_subscription.forbidden_change_events'));

      this.assertTypesMatchResource(dto.eventTypes, existing.resourceType);
      this.assertCanReadSubjects(dto.eventTypes, abilities);
    }

    const rotatedSecret = dto.secret;
    const updated = await this.db.webhookSubscription.update({
      where: { id },
      data: {
        url: dto.url,
        secret: rotatedSecret !== undefined ? this.encryption.encrypt(rotatedSecret) : undefined,
        eventTypes: dto.eventTypes
          ? { deleteMany: {}, create: dto.eventTypes.map((eventType) => ({ eventType })) }
          : undefined,
      },
      include: { eventTypes: true },
    });

    return rotatedSecret !== undefined ? this.reveal(updated, rotatedSecret) : this.redact(updated);
  }

  /**
   * Owner-initiated disable. Distinct status from failure auto-disable.
   */
  async disable(id: string): Promise<WebhookSubscriptionWithEventTypes> {
    await this.getById(id);

    const updated = await this.db.webhookSubscription.update({
      where: { id },
      data: { status: WebhookSubscriptionStatus.Disabled, disabledAt: new Date() },
      include: { eventTypes: true },
    });

    return this.redact(updated);
  }

  /**
   * Re-activates a Disabled/Failed subscription: resets the failure counter and
   * re-runs the *full* create-time authorization — subject grant plus the
   * instance/household scope checks — since the creator's access may have
   * narrowed while the subscription was down. (Dispatch re-gates Event subjects
   * regardless, but re-activation should not silently restore a scope the
   * creator can no longer reach.)
   */
  async reactivate(id: string): Promise<WebhookSubscriptionWithEventTypes> {
    const abilities = this.requireAbilities(t('errors.webhook_subscription.forbidden_reactivate'));

    const existing = await this.getById(id);

    this.assertCanReadSubjects(
      existing.eventTypes.map((row) => row.eventType as WebhookEventType),
      abilities,
    );

    if (existing.householdId) {
      await this.assertCanReadHousehold(existing.householdId, abilities);
    }

    if (existing.resourceId) {
      await this.assertCanReadInstance(existing.resourceType, existing.resourceId, abilities);
    }

    const updated = await this.db.webhookSubscription.update({
      where: { id },
      data: { status: WebhookSubscriptionStatus.Active, consecutiveFailures: 0, disabledAt: null },
      include: { eventTypes: true },
    });

    return this.redact(updated);
  }

  /** Soft delete. */
  async remove(id: string): Promise<WebhookSubscriptionWithEventTypes> {
    await this.getById(id);
    const updated = await this.db.webhookSubscription.update({
      where: { id },
      data: { deletedAt: new Date(), status: WebhookSubscriptionStatus.Disabled },
      include: { eventTypes: true },
    });

    return this.redact(updated);
  }

  /**
   * Resolves the acting principal's abilities for the imperative `.can()` /
   * `accessibleBy` checks below. An empty set must fail loudly: `[].every()` is
   * vacuously true, so without this guard a principal with no abilities would
   * *pass* the subject checks.
   */
  private requireAbilities(message: I18nMessage): AppAbility[] {
    const abilities = this.abilityService.getCurrentAbilities();
    if (abilities.length === 0) {
      throw new ForbiddenException(message);
    }
    return abilities;
  }

  private assertTypesMatchResource(types: readonly WebhookEventType[], resourceType: ResourceType): void {
    for (const type of types) {
      const descriptor = this.registry.get(type);
      if (!descriptor) {
        throw new BadRequestException(t('errors.webhook_subscription.unknown_event_type', { type }));
      }

      if (descriptor.subject !== resourceType) {
        throw new BadRequestException(
          t('errors.webhook_subscription.event_type_resource_mismatch', { type, resourceType }),
        );
      }
    }
  }

  private assertCanReadSubjects(types: readonly WebhookEventType[], abilities: AppAbility[]): void {
    for (const type of types) {
      const descriptor = this.registry.require(type);

      const permitted = abilities.every((ability) => ability.can(descriptor.requiredAction, descriptor.subject));
      if (!permitted) {
        throw new ForbiddenException(
          t('errors.webhook_subscription.forbidden_subject_access', {
            action: descriptor.requiredAction,
            subject: descriptor.subject,
          }),
        );
      }
    }
  }

  private async assertCanReadHousehold(householdId: string, abilities: AppAbility[]): Promise<void> {
    for (const ability of abilities) {
      const count = await this.db.household.count({
        where: { id: householdId, deletedAt: null, AND: [accessibleBy(ability).ofType(ResourceType.Household)] },
      });

      if (count === 0) {
        throw new ForbiddenException(t('errors.webhook_subscription.forbidden_household', { householdId }));
      }
    }
  }

  private async assertCanReadInstance(
    resourceType: ResourceType,
    resourceId: string,
    abilities: AppAbility[],
  ): Promise<void> {
    for (const ability of abilities) {
      const visible = await this.visibility.isVisibleTo(resourceType, resourceId, ability);
      if (!visible) {
        throw new ForbiddenException(
          t('errors.webhook_subscription.forbidden_instance', { resourceType, resourceId }),
        );
      }
    }
  }

  /**
   * Swaps the stored ciphertext for the one-time plaintext on the returned record.
   */
  private reveal(
    subscription: WebhookSubscriptionWithEventTypes,
    plaintextSecret: string,
  ): WebhookSubscriptionWithEventTypes {
    return { ...subscription, secret: plaintextSecret };
  }

  /**
   * Replaces the stored ciphertext with the redaction sentinel on the returned record.
   */
  private redact(subscription: WebhookSubscriptionWithEventTypes): WebhookSubscriptionWithEventTypes {
    return { ...subscription, secret: WEBHOOK_SECRET_REDACTED };
  }

  private generateSecret(): string {
    return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  }
}
