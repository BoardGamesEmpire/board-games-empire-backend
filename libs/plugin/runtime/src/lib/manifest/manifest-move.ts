import type { Prisma } from '@bge/database';

/**
 * How the active plugin manifest stopped being the one a request derived its
 * judgments from (#323, #368). Two writers can do it, and `version` alone cannot tell
 * them apart: activation promotes a new version in place and never touches
 * `installedAt`, while a reinstall over an uninstalled plugin replaces `manifestJson`
 * on the same row — same id, same slug — at whatever version it was handed,
 * so it may move the version too. `installedAt` is therefore what
 * classifies: only the installer writes it.
 *
 * The distinction reaches the client because the two differ in what
 * survived. A reinstall's uninstall purged every grant for the plugin, so
 * consent starts from zero. An activation keeps every grant whose permission
 * the new plugin manifest still declares — it deletes the grants on REMOVED
 * declares, which is not the same event: those lapsed with the permission
 * they were consent to, and nothing is left to re-consent to.
 *
 * Two arms, and a same-version re-activation (#368) adds no third: the
 * guard now also refuses an A→B→A pair, which moves the content while
 * leaving both columns where they were, and that pair is an activation —
 * consent to what the plugin manifest still declares outlived it. `kind` answers
 * "does the user start from zero", so the new case needs a different
 * SENTENCE, not a different kind.
 */
export type PluginChangeKind = 'reinstalled' | 'version-activated';

/**
 * Identifies the plugin manifest a caller derived its gates from, so a locked
 * re-read can detect a replacement.
 *
 * `manifestJson` is what DETECTS a replacement, and the other two columns
 * are what CLASSIFY it. Neither of them can be the detector: staging refuses
 * only a version equal to the CURRENT one, so activations away from and back
 * to a version (A->B->A) are permitted, and that pair restores `version` while
 * never touching `installedAt` — the installer is its only writer — leaving a
 * replaced plugin manifest invisible to both (#368). Comparing the content closes
 * that, and closes it self-enforcingly: a generation counter would have to be
 * bumped by every future writer of `manifest_json`, and one that forgot would
 * reopen this hole with nothing failing.
 *
 * They stay for the classification, which content cannot do: a reinstall that
 * writes a byte-identical plugin manifest still purged every grant, and nothing about
 * the document says so.
 */
export interface ManifestSnapshot {
  readonly version: string;
  readonly installedAt: Date;
  readonly manifestJson: Prisma.JsonValue;
}

/**
 * The columns a claiming read of the `plugins` row returns for the
 * comparison. `manifest_matches` is `manifest_json = <bound>::jsonb`, which is
 * NULL when nothing was bound.
 */
export interface ClaimedPluginRow {
  readonly uninstalled_at: Date | null;
  readonly version: string;
  readonly installed_at: Date;
  readonly manifest_matches: boolean | null;
}

/**
 * The text to bind as the expected plugin manifest, cast `::jsonb` in SQL so the
 * comparison is `jsonb = jsonb`: normalized, so key order and spacing cannot
 * manufacture a false mismatch (#578).
 *
 * The document has been through JS since it was stored (Prisma parses jsonb
 * on the way out), which is exact for everything a plugin manifest holds: strings,
 * booleans, and numbers within double precision, with jsonb comparing numbers
 * numerically so a lost trailing zero is still equal. A plugin manifest carrying an
 * integer past 2^53 would round-trip differently and refuse every request
 * for the plugin — retryable and loud rather than silent, and no plugin manifest
 * field is a number at all today.
 */
export function bindManifest(manifestJson: Prisma.JsonValue): string {
  return JSON.stringify(manifestJson);
}

/**
 * Names the move a claimed row made against what the caller read, or `null`
 * when nothing moved. It does not judge an uninstalled plugin; callers check
 * `uninstalled_at` first.
 *
 * `installed_at` is tested FIRST because it is the unambiguous signal: the
 * installer is its only writer, so a move means a reinstall and nothing
 * else. A version move is not equally decisive — a reinstall over an
 * uninstalled plugin installs whatever version it was handed, so it can move BOTH
 * columns, and testing version first would report that reinstall as an
 * activation. The distinction is client-visible and load-bearing: a
 * reinstall purged every grant for the plugin, an activation kept them.
 *
 * When neither column moved, an activation pair returned the version to
 * where the caller found it (#368). The kind is still `version-activated`,
 * because that pair did not send consent back to zero the way a reinstall
 * does.
 *
 * Anything other than TRUE from the content comparison is a move: the column
 * is NOT NULL and the bound document is non-null whenever a snapshot is
 * compared, so a NULL answer means the comparison did not run, and a guard
 * that read that as "unchanged" would be no guard at all.
 */
export function classifyManifestMove(row: ClaimedPluginRow, expected: ManifestSnapshot): PluginChangeKind | null {
  if (row.installed_at.getTime() !== expected.installedAt.getTime()) {
    return 'reinstalled';
  }

  if (row.version !== expected.version) {
    return 'version-activated';
  }

  if (row.manifest_matches !== true) {
    return 'version-activated';
  }

  return null;
}

/**
 * The sentence a refusal carries for a plugin manifest move, one wording for
 * every error that reports one so the operator reads the same account in the
 * logs wherever the guard fired (#578). Clients get the localized message
 * instead, never this text. Retryable immediately: whatever moved the
 * plugin manifest has committed by the time the refusal is raised.
 *
 * The version pair alone cannot say what happened — it is equal for a
 * same-version reinstall and for an A->B->A activation — which is why `kind`
 * leads and the equal-version activation gets its own sentence.
 */
export function describeManifestMove(
  pluginSlug: string,
  kind: PluginChangeKind,
  expectedVersion: string,
  actualVersion: string,
): string {
  if (kind === 'reinstalled') {
    return (
      `Plugin '${pluginSlug}' was reinstalled at version ${actualVersion} while this request was in flight; ` +
      `retry against the current plugin manifest`
    );
  }

  if (expectedVersion === actualVersion) {
    return (
      `Plugin '${pluginSlug}' was re-activated at version ${actualVersion} with different plugin manifest content ` +
      `while this request was in flight; retry against the current plugin manifest`
    );
  }

  return (
    `Plugin '${pluginSlug}' was activated from version ${expectedVersion} to ${actualVersion} while this ` +
    `request was in flight; retry against the current plugin manifest`
  );
}
