import { Action, DatabaseService, Prisma, Quota, QuotaScope, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService } from '@bge/permissions';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'node:crypto';
import { QuotaEvents } from './constants/quota-events.constant';
import { DEFAULT_SCOPE_ID, type QuotaResource } from './constants/quota-resource';
import type { QuotaView } from './dto/quota-response.dto';
import type { SetQuotaDto } from './dto/set-quota.dto';
import type {
  QuotaCheckContext,
  QuotaCheckResult,
  QuotaConstraint,
  QuotaExecutor,
  QuotaSoftOverageEvent,
  QuotaUpdatedEvent,
  QuotaUsageProvider,
} from './interfaces';
import { toPublicScopeId, toQuotaView, toStorageScopeId } from './quota.serialization';
import { QuotaResourceRegistry } from './registry/quota-resource.registry';

/** A scope the check should evaluate, paired with its resolved concrete target. */
interface ResolvedTarget {
  readonly scope: QuotaScope;
  readonly scopeId: string;
}

/** The subset of a quota row the resolver reads. */
type QuotaRow = { scope: QuotaScope; scopeId: string; limit: bigint; softOverage: boolean; enforced: boolean };

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly registry: QuotaResourceRegistry,
    private readonly eventEmitter: EventEmitter2,
    private readonly abilityService: AbilityService,
  ) {}

  /**
   * Read-only headroom evaluation: reads usage live with no lock, so concurrent
   * writers can both pass against the same figure and overshoot a *hard* cap.
   * Use for fast-fail/UI; the race-free pre-write gate is `consume(...)`.
   */
  async check(resource: QuotaResource, amount: bigint, ctx: QuotaCheckContext): Promise<QuotaCheckResult> {
    if (amount < 0n) {
      throw new BadRequestException(t('errors.quota.check_amount_negative'));
    }

    const definition = this.registry.require(resource);
    const usage = this.registry.requireUsage(resource);

    const targets = this.resolveTargets(definition.applicableScopes, ctx);
    if (targets.length === 0) {
      return this.unconstrained();
    }

    const applicable = await this.loadApplicable(this.databaseService, resource, targets);
    if (applicable.length === 0) {
      return this.unconstrained();
    }

    // Read path — no transaction to roll back, so warn eagerly (warn-every).
    const result = await this.evaluate(this.databaseService, resource, usage, applicable, amount);
    this.emitSoftOverages(result.softOverages);
    return result;
  }

  /**
   * Race-free counterpart to `check()`. MUST be called inside the caller's
   * interactive transaction, and the caller MUST perform the usage-moving write
   * in that SAME transaction. Acquires a transaction-scoped advisory lock on
   * every applicable (enforced) scope — ascending by key so overlapping sets
   * lock in one order (deadlock-free) — then re-measures usage under the lock.
   * The lock is held until the transaction commits/rolls back, so two consumers
   * of the same cap serialize across measure+write and a hard cap can't be
   * overshot. Limits are read just before locking; concurrent admin limit edits
   * (which don't take this lock) are out of scope, by design.
   */
  async consume(
    resource: QuotaResource,
    amount: bigint,
    ctx: QuotaCheckContext,
    tx: Prisma.TransactionClient,
  ): Promise<QuotaCheckResult> {
    if (amount < 0n) {
      throw new BadRequestException(t('errors.quota.consume_amount_negative'));
    }

    const definition = this.registry.require(resource);
    const usage = this.registry.requireUsage(resource);

    const targets = this.resolveTargets(definition.applicableScopes, ctx);
    if (targets.length === 0) {
      return this.unconstrained();
    }

    const applicable = await this.loadApplicable(tx, resource, targets);
    if (applicable.length === 0) {
      return this.unconstrained();
    }

    const lockKeys = [
      ...new Set(applicable.map(({ scope, scopeId }) => this.advisoryLockKey(resource, scope, scopeId))),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const key of lockKeys) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;
    }

    // Runs inside the caller's transaction — do NOT emit here. Any soft-overage
    // warnings ride back on `result.softOverages`; the caller emits them via
    // `emitSoftOverages` after commit, so they never fire for a rolled-back write.
    return this.evaluate(tx, resource, usage, applicable, amount);
  }

  /** Enforced quota rows that apply to the targets (instance row, else type-level default). */
  private async loadApplicable(
    executor: QuotaExecutor,
    resource: QuotaResource,
    targets: ResolvedTarget[],
  ): Promise<{ scope: QuotaScope; scopeId: string; row: QuotaRow }[]> {
    const rows = await executor.quota.findMany({
      where: {
        resource,
        OR: targets.flatMap(({ scope, scopeId }) =>
          scopeId === DEFAULT_SCOPE_ID
            ? [{ scope, scopeId }]
            : [
                { scope, scopeId },
                { scope, scopeId: DEFAULT_SCOPE_ID },
              ],
        ),
      },
    });

    const applicable: { scope: QuotaScope; scopeId: string; row: QuotaRow }[] = [];
    for (const { scope, scopeId } of targets) {
      const row = this.mostSpecific(rows, scope, scopeId);
      if (row && row.enforced) {
        applicable.push({ scope, scopeId, row });
      }
    }
    return applicable;
  }

  /**
   * Measures usage (via `executor`), builds constraints, collects soft-overage
   * warnings, and picks the binding. It does NOT emit: emission is the caller's
   * to time. `check()` emits immediately; `consume()` hands the warnings back so
   * the caller emits them after its transaction commits (see `QuotaCheckResult`).
   */
  private async evaluate(
    executor: QuotaExecutor,
    resource: QuotaResource,
    usage: QuotaUsageProvider,
    applicable: { scope: QuotaScope; scopeId: string; row: QuotaRow }[],
    amount: bigint,
  ): Promise<QuotaCheckResult> {
    const usages = await Promise.all(applicable.map(({ scope, scopeId }) => usage(scope, scopeId, executor)));

    const constraints: QuotaConstraint[] = applicable.map(({ scope, scopeId, row }, index) => {
      const currentUsage = usages[index];
      return {
        scope,
        scopeId,
        limit: row.limit,
        currentUsage,
        softOverage: row.softOverage,
        exceeded: currentUsage + amount > row.limit,
      };
    });

    const softOverages = constraints
      .filter((c) => c.exceeded && c.softOverage)
      .map(
        (violation) =>
          ({
            scope: violation.scope,
            scopeId: toPublicScopeId(violation.scopeId),
            resource,
            currentUsage: violation.currentUsage.toString(),
            attemptedAmount: amount.toString(),
            limit: violation.limit.toString(),
          }) satisfies QuotaSoftOverageEvent,
      );

    const hardViolations = constraints.filter((c) => c.exceeded && !c.softOverage);
    const binding = this.pickBinding(hardViolations.length > 0 ? hardViolations : constraints);

    return {
      allowed: hardViolations.length === 0,
      scope: binding.scope,
      currentUsage: binding.currentUsage,
      limit: binding.limit,
      softOverage: binding.softOverage,
      constraints,
      softOverages,
    };
  }

  /**
   * Emits the soft-overage warnings a `check()`/`consume()` collected.
   * `check()` calls this itself (read path). A `consume()` caller MUST call it
   * only AFTER its transaction commits — the warnings describe usage a rollback
   * would undo. No-op on an empty list.
   */
  emitSoftOverages(events: readonly QuotaSoftOverageEvent[]): void {
    for (const event of events) {
      this.eventEmitter.emit(QuotaEvents.SoftOverage, event);
    }
  }

  /** Stable signed-64-bit key for pg_advisory_xact_lock(bigint). A collision only
   *  over-serializes two unrelated caps; it never under-locks. */
  private advisoryLockKey(resource: QuotaResource, scope: QuotaScope, scopeId: string): bigint {
    return createHash('sha1').update(`quota:${resource}:${scope}:${scopeId}`).digest().readBigInt64BE(0);
  }

  async getQuotas(): Promise<QuotaView[]> {
    const quotas = await this.databaseService.quota.findMany({
      where: { AND: this.abilityService.getCurrentResourceConditions(ResourceType.Quota, Action.read) },
      orderBy: [{ scope: 'asc' }, { resource: 'asc' }],
    });

    return quotas.map(toQuotaView);
  }

  async setQuota(
    scope: QuotaScope,
    publicScopeId: string | null,
    resource: QuotaResource,
    dto: SetQuotaDto,
  ): Promise<QuotaView> {
    const actorId = this.abilityService.getActingUserId();

    if (!this.registry.has(resource)) {
      throw new BadRequestException(t('errors.quota.unknown_resource', { resource }));
    }

    const definition = this.registry.require(resource);
    if (!definition.applicableScopes.includes(scope)) {
      throw new BadRequestException(
        t('errors.quota.scope_not_applicable', {
          resource,
          scope,
          applicable: definition.applicableScopes.join(', '),
        }),
      );
    }

    this.assertScopeTargetCoherent(scope, publicScopeId);

    const scopeId = toStorageScopeId(publicScopeId);

    let householdId: string | null;
    try {
      householdId = await this.resolveHouseholdId(scope, scopeId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new ForbiddenException(t('errors.quota.forbidden_manage'));
      }

      throw error;
    }

    const limit = dto.limit !== undefined ? this.parseLimit(dto.limit) : undefined;
    const key = { scope_scopeId_resource: { scope, scopeId, resource } };

    const patch = {
      ...(limit !== undefined ? { limit } : {}),
      ...(dto.softOverage !== undefined ? { softOverage: dto.softOverage } : {}),
      ...(dto.enforced !== undefined ? { enforced: dto.enforced } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      householdId,
      updatedById: actorId,
    } satisfies Prisma.QuotaUncheckedUpdateInput;

    const quota = await this.databaseService.$transaction(async (tx) => {
      let row: Quota;
      if (limit !== undefined) {
        row = await tx.quota.upsert({
          where: key,
          update: patch,
          create: {
            scope,
            scopeId,
            resource,
            limit,
            softOverage: dto.softOverage ?? false,
            enforced: dto.enforced ?? true,
            description: dto.description ?? null,
            householdId,
            createdById: actorId,
            updatedById: actorId,
          },
        });
      } else {
        const existing = await tx.quota.findUnique({ where: key, select: { id: true } });
        if (!existing) {
          throw new BadRequestException(t('errors.quota.limit_required'));
        }

        row = await tx.quota.update({ where: { id: existing.id }, data: patch });
      }

      const authorized = await tx.quota.count({
        where: {
          id: row.id,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Quota, Action.manage),
        },
      });

      if (authorized === 0) {
        throw new ForbiddenException(t('errors.quota.forbidden_manage'));
      }

      return row;
    });

    this.eventEmitter.emit(QuotaEvents.Updated, {
      scope,
      scopeId: publicScopeId,
      householdId,
      resource,
      limit: quota.limit.toString(),
      softOverage: quota.softOverage,
      enforced: quota.enforced,
    } satisfies QuotaUpdatedEvent);

    this.logger.debug(`Quota set: ${resource} @ ${scope}/${scopeId} = ${quota.limit} by ${actorId}`);

    return toQuotaView(quota);
  }

  private resolveTargets(applicableScopes: readonly QuotaScope[], ctx: QuotaCheckContext): ResolvedTarget[] {
    const targets: ResolvedTarget[] = [];
    for (const scope of applicableScopes) {
      switch (scope) {
        case QuotaScope.Server: {
          targets.push({ scope, scopeId: DEFAULT_SCOPE_ID });
          break;
        }

        case QuotaScope.User: {
          targets.push({ scope, scopeId: ctx.userId });
          break;
        }

        case QuotaScope.Household: {
          if (ctx.householdId) {
            targets.push({ scope, scopeId: ctx.householdId });
          }

          break;
        }

        case QuotaScope.HouseholdMember: {
          if (ctx.householdMemberId) {
            targets.push({ scope, scopeId: ctx.householdMemberId });
          }

          break;
        }
      }
    }

    return targets;
  }

  /** Instance row for the target, else the type-level default row, else undefined. */
  private mostSpecific(
    rows: readonly { scope: QuotaScope; scopeId: string; limit: bigint; softOverage: boolean; enforced: boolean }[],
    scope: QuotaScope,
    scopeId: string,
  ) {
    return (
      rows.find((row) => row.scope === scope && row.scopeId === scopeId) ??
      rows.find((row) => row.scope === scope && row.scopeId === DEFAULT_SCOPE_ID)
    );
  }

  /** Least-headroom constraint (limit − usage) — the one that "binds". */
  private pickBinding(pool: QuotaConstraint[]): QuotaConstraint {
    return pool.reduce((tightest, candidate) =>
      candidate.limit - candidate.currentUsage < tightest.limit - tightest.currentUsage ? candidate : tightest,
    );
  }

  private assertScopeTargetCoherent(scope: QuotaScope, publicScopeId: string | null): void {
    if (scope === QuotaScope.Server && publicScopeId !== null) {
      throw new BadRequestException(t('errors.quota.server_no_target'));
    }
  }

  private async resolveHouseholdId(scope: QuotaScope, scopeId: string): Promise<string | null> {
    if (scopeId === DEFAULT_SCOPE_ID) {
      return null;
    }

    switch (scope) {
      case QuotaScope.Household: {
        const household = await this.databaseService.household.findUnique({
          where: { id: scopeId },
          select: { id: true },
        });

        if (!household) {
          throw new NotFoundException(t('errors.quota.household_not_found', { scopeId }));
        }

        return scopeId;
      }

      case QuotaScope.HouseholdMember: {
        const member = await this.databaseService.householdMember.findUnique({
          where: { id: scopeId },
          select: { householdId: true },
        });

        if (!member) {
          throw new NotFoundException(t('errors.quota.household_member_not_found', { scopeId }));
        }

        return member.householdId;
      }

      default: {
        return null;
      }
    }
  }

  /** Parse a decimal-string limit to a non-negative bigint; 400 on anything else. */
  private parseLimit(raw: string): bigint {
    if (!/^\d+$/.test(raw)) {
      throw new BadRequestException(t('errors.quota.limit_invalid', { raw }));
    }

    return BigInt(raw);
  }

  private unconstrained(): QuotaCheckResult {
    return {
      allowed: true,
      scope: null,
      currentUsage: null,
      limit: null,
      softOverage: false,
      constraints: [],
      softOverages: [],
    };
  }
}
