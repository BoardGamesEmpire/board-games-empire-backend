import { ResourceType } from '@bge/database';

export type MediaKind = 'image' | 'document';

const DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set(['application/pdf']);

/** Kind is derived from the stored object's mime; video/audio aren't linkable yet. */
export function mediaKindForMime(mimeType: string): MediaKind | null {
  if (mimeType.startsWith('image/')) return 'image';
  if (DOCUMENT_MIME_TYPES.has(mimeType)) return 'document';
  return null;
}

/** Subjects with media join tables today. Grows with the registry. */
export const LINKABLE_SUBJECT_TYPES = [ResourceType.Game, ResourceType.Event] as const;
export type LinkableSubjectType = (typeof LINKABLE_SUBJECT_TYPES)[number];

export const linkKey = (subjectType: ResourceType, kind: MediaKind): string => `${subjectType}:${kind}`;
