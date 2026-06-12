import { actorUserId, AuditContextService } from '@bge/actor-context';
import { DatabaseService, type SafeHttpPolicy } from '@bge/database';
import { SafeHttpPolicyEventsService } from '@bge/secure-http';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UpdateSafeHttpPolicyDto } from './dto/update-safe-http-policy.dto';

@Injectable()
export class SafeHttpService {
  private readonly logger = new Logger(SafeHttpService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: SafeHttpPolicyEventsService,
    private readonly audit: AuditContextService,
  ) {}

  /**
   * Returns the singleton policy row. There can be only one (enforced by
   * the `singleton @unique` column on the model); finding multiple is a
   * schema-state bug worth surfacing loudly.
   */
  async getPolicy(): Promise<SafeHttpPolicy> {
    const rows = await this.db.safeHttpPolicy.findMany();

    if (rows.length === 0) {
      throw new NotFoundException('No SafeHttp policy found. Run the seed script to create the default singleton row.');
    }
    if (rows.length > 1) {
      throw new ConflictException(
        'Multiple SafeHttp policy rows found. There can be only one — the database is in an invalid state.',
      );
    }

    return rows[0];
  }

  /**
   * Apply a partial update to the singleton policy. Steps:
   *   1. Fetch existing row by ID.
   *   2. Compute effective post-update state for cross-field validation.
   *   3. Reject wildcard entries when effective `strictMode` is true.
   *   4. Persist with `updatedBy` derived from the actor context.
   *   5. Publish the update event on the Redis pub/sub channel so every
   *      API process refreshes its in-memory snapshot.
   *
   * The Redis publish is logged-but-not-thrown on failure — the DB row is
   * the source of truth, and a missed notification leaves subscribers on
   * the prior snapshot until the next event. The next admin write or a
   * scheduled `refresh()` recovers without operator action.
   */
  async updatePolicy(id: string, dto: UpdateSafeHttpPolicyDto): Promise<SafeHttpPolicy> {
    const existing = await this.db.safeHttpPolicy.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`SafeHttp policy ${id} not found`);
    }

    // Normalize hostname casing before validation and persistence. The
    // runtime loader (`SafeHttpPolicyService.normalize`) already lower-cases
    // on read; doing the same on write keeps GET/PATCH symmetric and means
    // the stored row matches what the loader operates on.
    const normalized: UpdateSafeHttpPolicyDto = {
      ...dto,
      ...(dto.allowedHosts !== undefined && {
        allowedHosts: dto.allowedHosts.map((h) => h.toLowerCase()),
      }),
      ...(dto.blockedHosts !== undefined && {
        blockedHosts: dto.blockedHosts.map((h) => h.toLowerCase()),
      }),
    };

    const effective = { ...existing, ...normalized };
    this.assertWildcardPolicyConsistent(effective);

    const updatedBy = actorUserId(this.audit.getActorOrThrow());
    const updated = await this.db.safeHttpPolicy.update({
      where: { id },
      data: {
        ...normalized,
        updatedBy,
      },
    });

    await this.events.publish({
      updatedAt: updated.updatedAt.toISOString(),
      updatedBy: updated.updatedBy,
    });

    this.logger.log(`SafeHttp policy updated by ${updatedBy ?? 'system'} — fields: ${Object.keys(dto).join(', ')}`);

    return updated;
  }

  /**
   * Cross-field validation: wildcards are illegal under strict mode. The
   * DTO validator accepts wildcards at the format level because it cannot
   * see what `strictMode` will be after the update lands. This check runs
   * after merging existing state with the DTO, so it catches:
   *   - DTO adds wildcards while existing state is strict and stays strict.
   *   - DTO flips strict ON while existing state already has wildcards.
   *   - DTO supplies both strict=true and wildcards in the same payload.
   */
  private assertWildcardPolicyConsistent(effective: SafeHttpPolicy): void {
    if (!effective.strictMode) return;

    const wildcardsIn = (list: readonly string[]): string[] => list.filter((entry) => entry.startsWith('*.'));

    const offenders: { field: string; entries: string[] }[] = [];
    const allowedWildcards = wildcardsIn(effective.allowedHosts);
    const blockedWildcards = wildcardsIn(effective.blockedHosts);

    if (allowedWildcards.length > 0) {
      offenders.push({ field: 'allowedHosts', entries: allowedWildcards });
    }
    if (blockedWildcards.length > 0) {
      offenders.push({ field: 'blockedHosts', entries: blockedWildcards });
    }

    if (offenders.length === 0) return;

    const detail = offenders.map((o) => `${o.field}: [${o.entries.join(', ')}]`).join('; ');

    throw new BadRequestException(
      `Wildcard entries are not permitted while strictMode is enabled. ` +
        `Either set strictMode to false or remove the wildcard entries. ` +
        `Offending: ${detail}`,
    );
  }
}
