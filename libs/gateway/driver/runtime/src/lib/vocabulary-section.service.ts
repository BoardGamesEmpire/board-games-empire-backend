import {
  DatabaseService,
  DataGatewayCapability,
  DataGatewaySectionFailure,
  isPrismaForeignKeyConstraintError,
  PlatformType,
} from '@bge/database';
import { GatewayLanguageInput, LanguageLinkService } from '@bge/language';
import { VocabularyLinkService, type PlatformEntry } from '@bge/vocabulary';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import type { GatewayLanguageEntry } from '@boardgamesempire/proto-gateway';
import { status } from '@grpc/grpc-js';
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { timeout, type Observable } from 'rxjs';
import { SECTION_LIST_TIMEOUT_MS } from './constants/vocabulary-section.constants';
import { VocabularySectionError } from './errors/vocabulary-section.error';
import { firstAnswer } from './utils/first-answer';
import { toStoredLanguageCodeFormat, toStoredPlatformType } from './utils/stored-enums';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A list the DataGateway doesn't implement, or one that failed in some other way. */
const listFailure = (err: unknown): DataGatewaySectionFailure =>
  (err as { code?: unknown } | null)?.code === status.UNIMPLEMENTED
    ? DataGatewaySectionFailure.ListUnsupported
    : DataGatewaySectionFailure.ListFailed;

/**
 * One section of a DataGateway's vocabulary, as a list job loads it (#718):
 * it asks the DataGateway for one list and links each entry, languages
 * under the unknown-language policy and the rest through the shared
 * vocabulary resolver. It records each section's outcome on its own row,
 * which the admin routes return beside the interview's.
 *
 * A section is best-effort: it holds nothing back, and one that fails is
 * tried again by its job, unless the DataGateway doesn't implement the
 * list, then after the next interview.
 */
@Injectable()
export class VocabularySectionService {
  private readonly logger = new Logger(VocabularySectionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly languageLinks: LanguageLinkService,
    private readonly vocabulary: VocabularyLinkService,
  ) {}

  /**
   * Asks for the list `capability` names and links each entry. Throws a
   * {@link VocabularySectionError} when the list call or the links fail,
   * the call failing too when the DataGateway doesn't answer in time.
   * Once `signal` aborts, as when the DataGateway's connection is replaced,
   * it stops waiting and starts no further write, and throws the abort's
   * reason as it is: a closed connection isn't the section failing.
   */
  async load(
    gatewayId: string,
    capability: DataGatewayCapability,
    driver: DataGatewayDriver,
    signal: AbortSignal,
  ): Promise<void> {
    const correlationId = crypto.randomUUID();

    switch (capability) {
      case DataGatewayCapability.ListLanguages: {
        const { languages } = await this.ask(driver.listLanguages({ correlationId }), signal);
        const entries = (languages ?? [])
          .map((entry) => this.toLanguageInput(gatewayId, entry))
          .filter((entry): entry is GatewayLanguageInput => entry !== null);
        return this.link(signal, () => this.languageLinks.interview(gatewayId, entries, signal));
      }

      case DataGatewayCapability.ListPlatforms: {
        const { platforms } = await this.ask(driver.listPlatforms({ correlationId }), signal);
        const entries = (platforms ?? []).map(
          (platform): PlatformEntry => ({
            externalId: platform.externalId,
            name: platform.name,
            abbreviation: platform.abbreviation,
            platformType: toStoredPlatformType(platform.platformType) ?? PlatformType.Other,
          }),
        );
        return this.link(signal, () => this.vocabulary.load('platform', gatewayId, entries, signal));
      }

      case DataGatewayCapability.ListCategories: {
        const { categories } = await this.ask(driver.listCategories({ correlationId }), signal);
        const entries = (categories ?? []).map(({ externalId, name }) => ({ externalId, name }));
        return this.link(signal, () => this.vocabulary.load('category', gatewayId, entries, signal));
      }

      case DataGatewayCapability.ListMechanics: {
        const { mechanics } = await this.ask(driver.listMechanics({ correlationId }), signal);
        const entries = (mechanics ?? []).map(({ externalId, name }) => ({ externalId, name }));
        return this.link(signal, () => this.vocabulary.load('mechanic', gatewayId, entries, signal));
      }

      default:
        throw new VocabularySectionError(
          DataGatewaySectionFailure.ListUnsupported,
          new Error(`${capability} is not a list a DataGateway can declare`),
        );
    }
  }

  /** Records that the section loaded at `at`, leaving its last failure in place. */
  recordLoaded(gatewayId: string, capability: DataGatewayCapability, at: Date): Promise<void> {
    return this.record(gatewayId, capability, { lastLoadedAt: at });
  }

  /** Records the section's failure: called once its job's last attempt fails. */
  recordFailed(
    gatewayId: string,
    capability: DataGatewayCapability,
    code: DataGatewaySectionFailure,
    at: Date,
  ): Promise<void> {
    return this.record(gatewayId, capability, { lastFailedAt: at, lastFailure: code });
  }

  /** The list call's answer, dropping the call and failing it once {@link SECTION_LIST_TIMEOUT_MS} passes. */
  private async ask<T>(call: Observable<T>, signal: AbortSignal): Promise<T> {
    try {
      return await firstAnswer(call.pipe(timeout({ first: SECTION_LIST_TIMEOUT_MS })), signal);
    } catch (err) {
      signal.throwIfAborted();
      throw new VocabularySectionError(listFailure(err), err);
    }
  }

  private async link(signal: AbortSignal, write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (err) {
      signal.throwIfAborted();
      throw new VocabularySectionError(DataGatewaySectionFailure.LinkFailed, err);
    }
  }

  /**
   * Writes the section's row only while its DataGateway is enabled and not
   * deleted, as the interview records its failures: a section that ran
   * after an admin disabled or deleted the DataGateway leaves no trace.
   */
  private async record(
    gatewayId: string,
    capability: DataGatewayCapability,
    data: { lastLoadedAt?: Date; lastFailedAt?: Date; lastFailure?: DataGatewaySectionFailure },
  ): Promise<void> {
    const live = await this.db.dataGateway.findFirst({
      where: { id: gatewayId, enabled: true, deletedAt: null },
      select: { id: true },
    });

    if (!live) {
      this.logger.debug(`Not recording DataGateway ${gatewayId}'s ${capability} section: it's disabled or deleted`);
      return;
    }

    try {
      await this.db.dataGatewaySection.upsert({
        where: { gatewayId_capability: { gatewayId, capability } },
        create: { gatewayId, capability, ...data },
        update: data,
      });
    } catch (err) {
      // Deleted for good since it was read.
      if (isPrismaForeignKeyConstraintError(err)) {
        this.logger.debug(`Not recording DataGateway ${gatewayId}'s ${capability} section: ${errorMessage(err)}`);
        return;
      }

      throw err;
    }
  }

  private toLanguageInput(gatewayId: string, entry: GatewayLanguageEntry): GatewayLanguageInput | null {
    const format = toStoredLanguageCodeFormat(entry.format);
    const value = entry.value?.trim();
    if (!format || !value) {
      this.logger.warn(
        `DataGateway ${gatewayId} listed a language it can't be linked by (value='${entry.value}', format=${entry.format}); skipping it`,
      );
      return null;
    }

    return {
      value,
      format,
      ietfTag: entry.ietfTag,
      iso6393: entry.iso6393,
      iso6391: entry.iso6391,
      name: entry.name,
      nativeName: entry.nativeName,
    };
  }
}
