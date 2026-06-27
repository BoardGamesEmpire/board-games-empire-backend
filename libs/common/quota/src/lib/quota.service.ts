import { Action, DatabaseService, Prisma, Quota, QuotaScope, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { QuotaEvents } from './constants/quota-events.constant';
import { DEFAULT_SCOPE_ID, type QuotaResource } from './constants/quota-resource';
import type { QuotaView } from './dto/quota-response.dto';
import type { SetQuotaDto } from './dto/set-quota.dto';
import type {
  QuotaCheckContext,
  QuotaCheckResult,
  QuotaConstraint,
  QuotaSoftOverageEvent,
  QuotaUpdatedEvent,
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
   * Evaluates whether `amount` of `resource` fits the applicable caps for `ctx`,
   * returning the per-scope breakdown and binding result. Callers throw
   * QuotaExceededException when `allowed` is false.
   *
   * Best-effort and non-atomic: usage is read live with no lock, so concurrent
   * writers can both pass against the same stale figure and overshoot a *hard*
   * cap. Acceptable under the overcommit-allowed design (soft caps are meant to
   * overshoot); a truly-atomic `consume(...)` for hard caps is tracked in #98.
   */
  async check(resource: QuotaResource, amount: bigint, ctx: QuotaCheckContext): Promise<QuotaCheckResult> {
    if (amount < 0n) {
      throw new BadRequestException('check amount must be non-negative');
    }

    const definition = this.registry.require(resource);
    const usage = this.registry.requireUsage(resource);

    const targets = this.resolveTargets(definition.applicableScopes, ctx);
    if (targets.length === 0) {
      return this.unconstrained();
    }

    const rows = await this.databaseService.quota.findMany({
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

    if (applicable.length === 0) {
      return this.unconstrained();
    }

    const usages = await Promise.all(applicable.map(({ scope, scopeId }) => usage(scope, scopeId)));

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

    const hardViolations = constraints.filter((c) => c.exceeded && !c.softOverage);

    for (const violation of constraints.filter((c) => c.exceeded && c.softOverage)) {
      this.eventEmitter.emit(QuotaEvents.SoftOverage, {
        scope: violation.scope,
        scopeId: toPublicScopeId(violation.scopeId),
        resource,
        currentUsage: violation.currentUsage.toString(),
        attemptedAmount: amount.toString(),
        limit: violation.limit.toString(),
      } satisfies QuotaSoftOverageEvent);
    }

    const binding = this.pickBinding(hardViolations.length > 0 ? hardViolations : constraints);

    return {
      allowed: hardViolations.length === 0,
      scope: binding.scope,
      currentUsage: binding.currentUsage,
      limit: binding.limit,
      softOverage: binding.softOverage,
      constraints,
    };
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
      throw new BadRequestException(`Unknown quota resource "${resource}"`);
    }

    const definition = this.registry.require(resource);
    if (!definition.applicableScopes.includes(scope)) {
      throw new BadRequestException(
        `Quota resource "${resource}" is not measured at ${scope} scope ` +
          `(applicable: ${definition.applicableScopes.join(', ')})`,
      );
    }

    this.assertScopeTargetCoherent(scope, publicScopeId);

    const scopeId = toStorageScopeId(publicScopeId);

    let householdId: string | null;
    try {
      householdId = await this.resolveHouseholdId(scope, scopeId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new ForbiddenException("You don't have permission to manage this quota");
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
          throw new BadRequestException('limit is required when creating a quota');
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
        throw new ForbiddenException("You don't have permission to manage this quota");
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
      throw new BadRequestException('Server-scope quotas have no instance target');
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
          throw new NotFoundException(`Household ${scopeId} not found`);
        }

        return scopeId;
      }

      case QuotaScope.HouseholdMember: {
        const member = await this.databaseService.householdMember.findUnique({
          where: { id: scopeId },
          select: { householdId: true },
        });

        if (!member) {
          throw new NotFoundException(`Household member ${scopeId} not found`);
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
      throw new BadRequestException(`limit must be a non-negative integer string (got "${raw}")`);
    }

    return BigInt(raw);
  }

  private unconstrained(): QuotaCheckResult {
    return { allowed: true, scope: null, currentUsage: null, limit: null, softOverage: false, constraints: [] };
  }
}
