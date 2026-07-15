import { DatabaseService, LanguageCodeFormat } from '@bge/database';
import { GatewayLanguageInput, LanguageLinkService } from '@bge/language';
import type { GatewayLanguageEntry, GatewayServiceClient } from '@boardgamesempire/proto-gateway';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

/**
 * Re-interview a gateway's languages at most this often. Pings happen on
 * every (re)connect and would otherwise re-run the interview each time.
 */
export const LANGUAGE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Proto LanguageCodeFormat → Prisma enum. Keyed by both the numeric enum
 * value and the string name — the gRPC client is configured with
 * `loader.enums: String`, so runtime values arrive as names even though the
 * generated types say number.
 */
const PROTO_FORMAT_MAP: Readonly<Record<string | number, LanguageCodeFormat>> = {
  1: LanguageCodeFormat.Iso6391,
  LANGUAGE_CODE_FORMAT_ISO_639_1: LanguageCodeFormat.Iso6391,
  2: LanguageCodeFormat.Iso6393,
  LANGUAGE_CODE_FORMAT_ISO_639_3: LanguageCodeFormat.Iso6393,
  3: LanguageCodeFormat.IetfBcp47,
  LANGUAGE_CODE_FORMAT_IETF_BCP_47: LanguageCodeFormat.IetfBcp47,
  4: LanguageCodeFormat.Name,
  LANGUAGE_CODE_FORMAT_NAME: LanguageCodeFormat.Name,
  5: LanguageCodeFormat.NativeName,
  LANGUAGE_CODE_FORMAT_NATIVE_NAME: LanguageCodeFormat.NativeName,
};

/**
 * The language half of the gateway capabilities interview: pulls the
 * gateway's ListLanguages inventory and feeds it to LanguageLinkService,
 * which upserts LanguageGatewayLink rows per the unknown-language policy.
 *
 * Runs after a successful connect, throttled by GameGateway.languagesSyncedAt
 * to once per LANGUAGE_SYNC_INTERVAL_MS — routine pings and reconnects inside
 * the window skip the interview entirely.
 */
@Injectable()
export class GatewayLanguageSyncService {
  private readonly logger = new Logger(GatewayLanguageSyncService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly languageLinks: LanguageLinkService,
  ) {}

  /**
   * Interview the gateway if its last sync is stale. Never throws — a failed
   * interview must not fail the connection it piggybacks on.
   */
  async syncIfStale(gatewayId: string, client: GatewayServiceClient): Promise<void> {
    try {
      const gateway = await this.db.gameGateway.findUnique({
        where: { id: gatewayId },
        select: { languagesSyncedAt: true },
      });

      if (!gateway) {
        return;
      }

      const lastSynced = gateway.languagesSyncedAt?.getTime() ?? 0;
      if (Date.now() - lastSynced < LANGUAGE_SYNC_INTERVAL_MS) {
        return;
      }

      const response = await firstValueFrom(client.listLanguages({}));
      const entries = (response.languages ?? [])
        .map((entry) => this.toInput(gatewayId, entry))
        .filter((entry): entry is GatewayLanguageInput => entry !== null);

      await this.languageLinks.interview(gatewayId, entries);

      await this.db.gameGateway.update({
        where: { id: gatewayId },
        data: { languagesSyncedAt: new Date() },
      });
    } catch (err) {
      // Includes gateways that predate ListLanguages (UNIMPLEMENTED). Stamp
      // the sync time anyway so a broken interview retries daily, not on
      // every reconnect.
      this.logger.warn(
        `Language interview for gateway ${gatewayId} failed: ${err instanceof Error ? err.message : err}`,
      );

      await this.db.gameGateway
        .update({ where: { id: gatewayId }, data: { languagesSyncedAt: new Date() } })
        .catch(() => undefined);
    }
  }

  private toInput(gatewayId: string, entry: GatewayLanguageEntry): GatewayLanguageInput | null {
    const format = PROTO_FORMAT_MAP[entry.format];
    if (!format || !entry.value?.trim()) {
      this.logger.warn(
        `Gateway ${gatewayId} sent an invalid ListLanguages entry (value='${entry.value}', format=${entry.format}); skipping`,
      );
      return null;
    }

    return {
      value: entry.value.trim(),
      format,
      ietfTag: entry.ietfTag,
      iso6393: entry.iso6393,
      iso6391: entry.iso6391,
      name: entry.name,
      nativeName: entry.nativeName,
    };
  }
}
