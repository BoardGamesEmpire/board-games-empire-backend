import {
  DatabaseService,
  LanguageCodeFormat,
  LanguageLinkOrigin,
  LanguageLinkStatus,
  LanguageTagSource,
} from '@bge/database';
import { canonicalizeTag, displayName, nativeDisplayName, parseTag } from '@bge/locale';
import { Injectable, Logger } from '@nestjs/common';
import { iso6393 as iso6393Registry } from 'iso-639-3';

/**
 * A gateway-native language value plus whatever enrichments the gateway
 * supplied. Proto-agnostic mirror of GatewayLanguageEntry / LanguageData —
 * callers map their wire types onto this.
 */
export interface GatewayLanguageInput {
  value: string;
  format: LanguageCodeFormat;
  ietfTag?: string;
  iso6393?: string;
  iso6391?: string;
  name?: string;
  nativeName?: string;
}

export interface InterviewSummary {
  resolved: number;
  pending: number;
  unresolved: number;
  ignored: number;
}

interface Resolution {
  status: LanguageLinkStatus;
  tagId: string | null;
}

/**
 * Resolves gateway-native language values to canonical LanguageTag rows via
 * LanguageGatewayLink, applying the hybrid unknown-language policy:
 *
 *  - Structured values (a valid BCP 47 tag, or a real ISO 639 code) resolve
 *    against the existing vocabulary; misses auto-add the Language/Tag
 *    (source: Gateway) — unless SystemSetting.reviewGatewayLanguages is on,
 *    in which case they park as Pending links awaiting review.
 *  - Free-text values (NAME/NATIVE_NAME formats without usable enrichments)
 *    match case-insensitively against tag and language display names;
 *    misses park as Unresolved links. Free text never creates vocabulary.
 *  - Every encounter is persisted — nothing is silently dropped. Rows with
 *    tagId = null (Pending/Unresolved) are the curation worklist; Ignored
 *    rows are explicitly dismissed and stay quiet.
 */
@Injectable()
export class LanguageLinkService {
  private readonly logger = new Logger(LanguageLinkService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Capabilities interview: upsert a link for every language the gateway
   * reports. Existing Resolved/Ignored links are left untouched; new and
   * previously-unresolved values get a fresh resolution attempt.
   */
  async interview(gatewayId: string, entries: GatewayLanguageInput[]): Promise<InterviewSummary> {
    const summary: InterviewSummary = { resolved: 0, pending: 0, unresolved: 0, ignored: 0 };

    for (const entry of entries) {
      const { status } = await this.registerEntry(gatewayId, entry, LanguageLinkOrigin.Interview);
      this.count(summary, status);
    }

    this.logger.log(
      `Language interview for gateway ${gatewayId}: ${entries.length} entries — ` +
        `${summary.resolved} resolved, ${summary.pending} pending review, ` +
        `${summary.unresolved} unresolved, ${summary.ignored} ignored`,
    );

    return summary;
  }

  /**
   * Import-path resolution: map a LanguageData-shaped payload to a tag id.
   * Consults links for each candidate representation (most specific first);
   * when none exist, attempts resolution and persists the encounter as an
   * Import-origin link. Returns null when the value is pending, unresolved,
   * or ignored — callers skip the association and re-syncs pick it up once
   * the link is curated.
   */
  async resolveLanguageData(
    gatewayId: string,
    data: { ietfTag?: string; iso6393?: string; iso6391?: string; name?: string },
  ): Promise<string | null> {
    const candidates = this.toCandidates(data);
    if (candidates.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      const value = this.normalizeValue(candidate.value, candidate.format);
      const link = await this.db.languageGatewayLink.findUnique({
        where: { gatewayId_value_format: { gatewayId, value, format: candidate.format } },
        select: { status: true, tagId: true },
      });

      if (link) {
        return link.status === LanguageLinkStatus.Resolved ? link.tagId : null;
      }
    }

    const resolution = await this.registerEntry(gatewayId, candidates[0], LanguageLinkOrigin.Import);
    if (resolution.status !== LanguageLinkStatus.Resolved) {
      this.logger.warn(
        `Gateway ${gatewayId} sent unknown language ${JSON.stringify(data)} — recorded as ${resolution.status} link`,
      );
      return null;
    }

    return resolution.tagId;
  }

  /**
   * The candidate (value, format) representations of a LanguageData payload,
   * most specific first. Only ietf_tag can carry script/region distinctions,
   * so it always wins when present.
   */
  private toCandidates(data: {
    ietfTag?: string;
    iso6393?: string;
    iso6391?: string;
    name?: string;
  }): GatewayLanguageInput[] {
    const enrichments = {
      ietfTag: data.ietfTag,
      iso6393: data.iso6393,
      iso6391: data.iso6391,
      name: data.name,
    };

    const candidates: GatewayLanguageInput[] = [];
    if (data.ietfTag) {
      candidates.push({ value: data.ietfTag, format: LanguageCodeFormat.IetfBcp47, ...enrichments });
    }
    if (data.iso6393) {
      candidates.push({ value: data.iso6393, format: LanguageCodeFormat.Iso6393, ...enrichments });
    }
    if (data.iso6391) {
      candidates.push({ value: data.iso6391, format: LanguageCodeFormat.Iso6391, ...enrichments });
    }
    if (data.name) {
      candidates.push({ value: data.name, format: LanguageCodeFormat.Name, ...enrichments });
    }

    return candidates;
  }

  /**
   * The canonical storage/lookup key for a candidate value. Structured
   * formats collapse to a single spelling — BCP 47 tags via ICU
   * canonicalization, ISO codes lowercased — so casing/whitespace variants
   * ('EN-us' vs 'en-US') reuse the same link row instead of spawning
   * duplicates. Free-text NAME/NATIVE_NAME values keep the gateway's literal
   * spelling: they are matched case-insensitively at resolution time and
   * shown verbatim on the curation worklist.
   */
  private normalizeValue(value: string, format: LanguageCodeFormat): string {
    switch (format) {
      case LanguageCodeFormat.IetfBcp47:
        return canonicalizeTag(value) ?? value.trim();
      case LanguageCodeFormat.Iso6391:
      case LanguageCodeFormat.Iso6393:
        return this.normalizeIso(value) ?? value.trim();
      default:
        // Free-text names keep their casing (display identity, matched
        // case-insensitively at resolution time) but collapse surrounding
        // and repeated whitespace so ' German ' and 'German' share one row.
        return value.trim().replace(/\s+/g, ' ');
    }
  }

  /**
   * Lowercase/trim an ISO 639 code for registry matching (the iso-639-3
   * registry is lowercase). Returns undefined for empty/absent input.
   */
  private normalizeIso(code: string | undefined): string | undefined {
    const normalized = code?.trim().toLowerCase();
    return normalized ? normalized : undefined;
  }

  /**
   * Upsert the link row for one entry and attempt resolution per policy.
   * Returns the link's (possibly pre-existing) resolution.
   */
  private async registerEntry(
    gatewayId: string,
    entry: GatewayLanguageInput,
    origin: LanguageLinkOrigin,
  ): Promise<Resolution> {
    // (gatewayId, value, format) is unique, so structured values must be
    // canonicalized before they key a row. Resolution runs on the normalized
    // entry too, so ISO lookups aren't defeated by gateway casing.
    const value = this.normalizeValue(entry.value, entry.format);
    const normalized = value === entry.value ? entry : { ...entry, value };

    const existing = await this.db.languageGatewayLink.findUnique({
      where: { gatewayId_value_format: { gatewayId, value, format: entry.format } },
      select: { status: true, tagId: true },
    });

    // Resolved links are stable; Ignored links were explicitly dismissed.
    // Pending links await review — re-encounters must not re-resolve them.
    if (existing && existing.status !== LanguageLinkStatus.Unresolved) {
      return { status: existing.status, tagId: existing.tagId };
    }

    const resolution = await this.resolveEntry(normalized);
    const supplied = {
      suppliedIso6393: entry.iso6393 ?? null,
      suppliedIso6391: entry.iso6391 ?? null,
      suppliedName: entry.name ?? null,
      suppliedNativeName: entry.nativeName ?? null,
    };

    await this.db.languageGatewayLink.upsert({
      where: { gatewayId_value_format: { gatewayId, value, format: entry.format } },
      create: {
        gatewayId,
        value,
        format: entry.format,
        origin,
        status: resolution.status,
        tagId: resolution.tagId,
        ...supplied,
      },
      update: {
        status: resolution.status,
        tagId: resolution.tagId,
        ...supplied,
      },
    });

    return resolution;
  }

  /**
   * Resolution core. Tries the entry's representations in order of
   * trustworthiness: canonical BCP 47 tag, then ISO codes, then display-name
   * matching. Structured misses may auto-add vocabulary (policy-gated);
   * free-text misses never do.
   */
  private async resolveEntry(entry: GatewayLanguageInput): Promise<Resolution> {
    // 1. BCP 47 — from the value itself (IetfBcp47 format) or enrichment.
    const rawTag = entry.format === LanguageCodeFormat.IetfBcp47 ? entry.value : entry.ietfTag;
    const canonical = canonicalizeTag(rawTag);
    if (canonical) {
      return this.resolveCanonicalTag(canonical, entry);
    }

    if (entry.format === LanguageCodeFormat.IetfBcp47) {
      // The gateway declared BCP 47 but sent something unparseable.
      return { status: LanguageLinkStatus.Unresolved, tagId: null };
    }

    // 2. ISO codes — from the value (Iso639x formats) or enrichments.
    // The registry is lowercase, so codes are lowercased before lookup:
    // a 'CES' enrichment on a NAME entry must still match 'ces'.
    const iso6393 = this.normalizeIso(entry.format === LanguageCodeFormat.Iso6393 ? entry.value : entry.iso6393);
    const iso6391 = this.normalizeIso(entry.format === LanguageCodeFormat.Iso6391 ? entry.value : entry.iso6391);
    if (iso6393 || iso6391) {
      return this.resolveIsoCodes(iso6393, iso6391, entry);
    }

    // 3. Free-text display name.
    return this.resolveByName(entry.value);
  }

  /**
   * A valid canonical tag resolves directly, or auto-adds the tag (and its
   * language when new) — parked as Pending instead when review is enabled.
   */
  private async resolveCanonicalTag(canonical: string, entry: GatewayLanguageInput): Promise<Resolution> {
    const tag = await this.db.languageTag.findUnique({ where: { tag: canonical }, select: { id: true } });
    if (tag) {
      return { status: LanguageLinkStatus.Resolved, tagId: tag.id };
    }

    const iso6393 = this.deriveIso6393(canonical, entry);
    if (!iso6393) {
      // Syntactically valid but not a registered language ("xq-XX").
      return { status: LanguageLinkStatus.Unresolved, tagId: null };
    }

    if (await this.reviewRequired()) {
      return { status: LanguageLinkStatus.Pending, tagId: null };
    }

    const languageId = await this.ensureLanguage(iso6393, entry);
    const createdTag = await this.createTag(canonical, languageId, entry);
    return { status: LanguageLinkStatus.Resolved, tagId: createdTag };
  }

  /**
   * ISO-code resolution lands on the language's bare tag.
   */
  private async resolveIsoCodes(
    iso6393: string | undefined,
    iso6391: string | undefined,
    entry: GatewayLanguageInput,
  ): Promise<Resolution> {
    const registryEntry = iso6393Registry.find(
      (candidate) => (iso6393 ? candidate.iso6393 === iso6393 : false) || (iso6391 ? candidate.iso6391 === iso6391 : false),
    );

    if (!registryEntry) {
      return { status: LanguageLinkStatus.Unresolved, tagId: null };
    }

    const bareTag = canonicalizeTag(registryEntry.iso6391 ?? registryEntry.iso6393);
    if (!bareTag) {
      return { status: LanguageLinkStatus.Unresolved, tagId: null };
    }

    const tag = await this.db.languageTag.findUnique({ where: { tag: bareTag }, select: { id: true } });
    if (tag) {
      return { status: LanguageLinkStatus.Resolved, tagId: tag.id };
    }

    if (await this.reviewRequired()) {
      return { status: LanguageLinkStatus.Pending, tagId: null };
    }

    const languageId = await this.ensureLanguage(registryEntry.iso6393, entry);
    const createdTag = await this.createTag(bareTag, languageId, entry);
    return { status: LanguageLinkStatus.Resolved, tagId: createdTag };
  }

  /**
   * Free-text matching: tag display name first, then language display name
   * (landing on that language's bare tag). Never creates vocabulary.
   */
  private async resolveByName(value: string): Promise<Resolution> {
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name) {
      return { status: LanguageLinkStatus.Unresolved, tagId: null };
    }

    const byTagName = await this.db.languageTag.findFirst({
      where: {
        OR: [{ name: { equals: name, mode: 'insensitive' } }, { nativeName: { equals: name, mode: 'insensitive' } }],
      },
      select: { id: true },
    });

    if (byTagName) {
      return { status: LanguageLinkStatus.Resolved, tagId: byTagName.id };
    }

    const language = await this.db.language.findFirst({
      where: {
        OR: [{ name: { equals: name, mode: 'insensitive' } }, { nativeName: { equals: name, mode: 'insensitive' } }],
      },
      select: { id: true, iso6391: true, iso6393: true },
    });

    if (language) {
      const bareTag = canonicalizeTag(language.iso6391 ?? language.iso6393);
      const tag = bareTag
        ? await this.db.languageTag.findUnique({ where: { tag: bareTag }, select: { id: true } })
        : null;

      if (tag) {
        return { status: LanguageLinkStatus.Resolved, tagId: tag.id };
      }
    }

    return { status: LanguageLinkStatus.Unresolved, tagId: null };
  }

  /**
   * ISO 639-3 for a canonical tag: supplied enrichment, a 3-letter primary
   * subtag verbatim, or a 2-letter primary subtag looked up in the ISO 639-3
   * registry. Null when the subtag isn't a registered language.
   */
  private deriveIso6393(canonical: string, entry: GatewayLanguageInput): string | null {
    const primary = parseTag(canonical)?.language;
    if (!primary) {
      return null;
    }

    const registryEntry =
      primary.length === 3
        ? iso6393Registry.find((candidate) => candidate.iso6393 === primary)
        : iso6393Registry.find((candidate) => candidate.iso6391 === primary);

    // The canonical tag's own primary subtag is authoritative for the
    // language — trusting it prevents a misbehaving gateway from attaching a
    // tag (e.g. 'en-AU') to an unrelated language by sending a contradictory
    // iso6393. A supplied iso6393 enrichment is only consulted as a fallback
    // when the primary subtag isn't itself a registered language.
    if (registryEntry) {
      return registryEntry.iso6393;
    }

    const enrichedCode = this.normalizeIso(entry.iso6393);
    const enriched = enrichedCode
      ? iso6393Registry.find((candidate) => candidate.iso6393 === enrichedCode)
      : undefined;

    return enriched?.iso6393 ?? null;
  }

  private async ensureLanguage(iso6393: string, entry: GatewayLanguageInput): Promise<string> {
    const existing = await this.db.language.findUnique({ where: { iso6393 }, select: { id: true } });
    if (existing) {
      return existing.id;
    }

    const registryEntry = iso6393Registry.find((candidate) => candidate.iso6393 === iso6393);
    const iso6391 = registryEntry?.iso6391 ?? null;
    const bareTag = canonicalizeTag(iso6391 ?? iso6393);
    const name = (bareTag && displayName(bareTag)) ?? registryEntry?.name ?? entry.name ?? iso6393;
    const nativeName = (bareTag && nativeDisplayName(bareTag)) ?? entry.nativeName ?? null;

    // Upsert (not create) so concurrent imports/interviews that both saw the
    // language missing don't race to a duplicate-key crash on iso6393; the
    // loser's insert resolves to a no-op update and returns the winner's row.
    const language = await this.db.language.upsert({
      where: { iso6393 },
      create: { iso6393, iso6391, name, nativeName },
      update: {},
      select: { id: true },
    });

    this.logger.log(`Auto-added language '${name}' (${iso6393}) from gateway data`);
    return language.id;
  }

  private async createTag(canonical: string, languageId: string, entry: GatewayLanguageInput): Promise<string> {
    const parsed = parseTag(canonical);
    const name = displayName(canonical) ?? entry.name ?? canonical;

    // Upsert guards the same check-then-create race as ensureLanguage: a
    // concurrent worker may insert this tag between the caller's existence
    // check and here. The unique 'tag' key makes the loser a no-op update.
    const tag = await this.db.languageTag.upsert({
      where: { tag: canonical },
      create: {
        tag: canonical,
        script: parsed?.script ?? null,
        region: parsed?.region ?? null,
        name,
        nativeName: nativeDisplayName(canonical) ?? entry.nativeName ?? null,
        source: LanguageTagSource.Gateway,
        languageId,
      },
      update: {},
      select: { id: true },
    });

    this.logger.log(`Auto-added language tag '${canonical}' (${name}) from gateway data`);
    return tag.id;
  }

  private async reviewRequired(): Promise<boolean> {
    const settings = await this.db.systemSetting.findFirst({
      where: { singleton: true },
      select: { reviewGatewayLanguages: true },
    });

    return settings?.reviewGatewayLanguages ?? false;
  }

  private count(summary: InterviewSummary, status: LanguageLinkStatus): void {
    switch (status) {
      case LanguageLinkStatus.Resolved:
        summary.resolved++;
        break;
      case LanguageLinkStatus.Pending:
        summary.pending++;
        break;
      case LanguageLinkStatus.Ignored:
        summary.ignored++;
        break;
      default:
        summary.unresolved++;
    }
  }
}
