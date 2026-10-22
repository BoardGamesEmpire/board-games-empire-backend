import type { PlatformType, VocabularyLinkOrigin, VocabularyLinkStatus } from '@bge/database';

/** A vocabulary whose records a DataGateway's entries are matched to (#718). */
export type VocabularyKind = 'platform' | 'category' | 'mechanic' | 'family';

/** The kinds with a status, a review setting and a list job. Families have none (#718). */
export type ReviewedVocabularyKind = Exclude<VocabularyKind, 'family'>;

/** One entry as a DataGateway sends it: its own id for it, and its name. */
export interface VocabularyEntry {
  externalId: string;
  name: string;
}

/** A platform entry also carries what its record is made from. */
export interface PlatformEntry extends VocabularyEntry {
  abbreviation?: string;
  platformType: PlatformType;
}

export type EntryOf<K extends VocabularyKind> = K extends 'platform' ? PlatformEntry : VocabularyEntry;

/** What a list job did with each entry. */
export interface LoadSummary {
  /** No record matched, so one was made, with its link. */
  created: number;
  /** Linked to a record of the same slug or a similar name. */
  matched: number;
  /** Matched nothing while review was on, so it waits for an admin. */
  pending: number;
  /** Already linked, in any status, and left as it was. */
  kept: number;
}

/** How an admin's accept of a Pending link went (#715). */
export type AcceptOutcome =
  | { readonly accepted: true; readonly recordId: string }
  | { readonly accepted: false; readonly reason: 'not_pending' };

/** The record a link points at, as the review routes show it. */
export interface VocabularyRecordView {
  id: string;
  name: string;
  slug: string;
}

/** A platform, category or mechanic link as the review routes return it (#715, #718). */
export interface VocabularyLinkView {
  id: string;
  gatewayId: string;
  externalId: string;
  status: VocabularyLinkStatus;
  origin: VocabularyLinkOrigin;
  record: VocabularyRecordView | null;
  suppliedName: string;
  /** Platforms only. */
  suppliedAbbreviation: string | null;
  /** Platforms only. */
  suppliedPlatformType: PlatformType | null;
  createdAt: Date;
  updatedAt: Date;
}
