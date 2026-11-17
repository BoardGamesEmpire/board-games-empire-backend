import { PluginGrantStatus, type RiskLevel } from '@bge/database';
import request from 'supertest';
import type { Caller } from '../support/api-key';

/**
 * Consent acts driven over HTTP, with every body built from a consent surface
 * the same request flow read first (#1150).
 *
 * An act names the manifest sha and each answered permission's risk level as
 * the consent surface showed them, and the server refuses an act whose sha or
 * risk has moved. A body built from constants would therefore pin a fixture's
 * guess rather than what the unit was shown, and would go stale the day the
 * fixture's manifest or catalog changes. So no helper here takes a sha or a
 * risk level: each one reads them off a {@link ConsentSurface}.
 */

/** Whoever sends the request: a session, or an API key (#1150). Only its headers are sent. */
export type ActCaller = Caller;

/** A decision a unit can answer with: the two statuses an act accepts. */
export type ConsentAnswerStatus = typeof PluginGrantStatus.Granted | typeof PluginGrantStatus.Denied;

/** One answer in an act body, as the act DTOs accept it. */
export interface ConsentAnswerBody {
  readonly permissionSlug: string;
  readonly status: ConsentAnswerStatus;
  readonly riskLevel: RiskLevel;
}

/** The parts of a consent surface an act body is built from. */
export interface ConsentSurface {
  readonly manifestSha256: string;
  readonly stagedUpdate: { readonly manifestVersion: string; readonly manifestSha256: string } | null;
  readonly checks: readonly ConsentSurfaceCheck[];
}

/**
 * One requested permission as the consent surface shows it: the fields an act
 * body is built from, and the ones a spec compares an act's recorded
 * presentation against (#1150).
 */
export interface ConsentSurfaceCheck {
  readonly slug: string;
  readonly required: boolean;
  readonly feature: string | null;
  readonly riskLevel: RiskLevel | null;
  readonly decidableByUnit: boolean;
  readonly grantable: boolean;
  readonly stagedOnly: boolean;
  readonly decision: string;
  readonly reason: { readonly value: string };
}

/**
 * The unit an act is addressed to: a household, the signed-in user, or the
 * Server unit, whose acts a server admin records (#1336).
 *
 * The route families differ only in their prefix, so a helper takes the unit
 * rather than a path, and a spec cannot pair one unit's surface with another
 * unit's act route by accident.
 */
export type ConsentActUnit = { readonly householdId: string } | 'me' | 'server';

/** The plugins route prefix for a unit. */
export function unitPluginsPath(unit: ConsentActUnit): string {
  if (unit === 'server') {
    return '/api/plugins';
  }

  return unit === 'me' ? '/api/users/me/plugins' : `/api/households/${unit.householdId}/plugins`;
}

/**
 * Reads the unit's consent surface for a plugin and returns it, failing the
 * test with the response body when the read is not a 200.
 *
 * `staged` reads the staged update's consent surface instead (pre-consent).
 */
export async function readConsentSurface(
  baseUrl: string,
  actor: ActCaller,
  unit: ConsentActUnit,
  slug: string,
  options: { readonly staged?: boolean } = {},
): Promise<ConsentSurface> {
  const response = await request(baseUrl)
    .get(`${unitPluginsPath(unit)}/${slug}/consent`)
    .query(options.staged === true ? { manifest: 'staged' } : {})
    .set(actor.headers);

  if (response.status !== 200) {
    throw new Error(
      `Reading the consent surface of ${slug} answered ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }

  return response.body.presentation as ConsentSurface;
}

/**
 * One answer, with the risk level the consent surface shows for that
 * requested permission. Throws when the surface does not list the permission
 * or shows it with no risk level, since no act could answer it either.
 */
export function answerFrom(
  surface: ConsentSurface,
  permissionSlug: string,
  status: ConsentAnswerStatus,
): ConsentAnswerBody {
  const check = surface.checks.find((candidate) => candidate.slug === permissionSlug);

  if (check === undefined) {
    throw new Error(
      `The consent surface lists no requested permission '${permissionSlug}' ` +
        `(it lists ${surface.checks.map((candidate) => candidate.slug).join(', ')}).`,
    );
  }

  if (check.riskLevel === null) {
    throw new Error(`The consent surface shows no risk level for '${permissionSlug}', so no act can answer it.`);
  }

  return { permissionSlug, status, riskLevel: check.riskLevel };
}

/**
 * The switch-on body: the surface's sha, and one answer per named permission.
 * Pass no answers when the unit decides no required permission and the test
 * wants the optional ones left for later.
 */
export function switchOnBody(
  surface: ConsentSurface,
  answers: Readonly<Record<string, ConsentAnswerStatus>> = {},
  config?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    manifestSha256: surface.manifestSha256,
    answers: Object.entries(answers).map(([slug, status]) => answerFrom(surface, slug, status)),
    ...(config !== undefined ? { config } : {}),
  };
}

/** The toggle body: the surface's sha and one answer to one optional permission. */
export function toggleBody(
  surface: ConsentSurface,
  permissionSlug: string,
  status: ConsentAnswerStatus,
): Record<string, unknown> {
  return { manifestSha256: surface.manifestSha256, answer: answerFrom(surface, permissionSlug, status) };
}

/**
 * The review body: the surface's sha and the named answers. For a staged
 * update, read the surface with `staged: true` first, so the sha is the staged
 * one.
 */
export function reviewBody(
  surface: ConsentSurface,
  answers: Readonly<Record<string, ConsentAnswerStatus>>,
): Record<string, unknown> {
  return {
    manifestSha256: surface.manifestSha256,
    answers: Object.entries(answers).map(([slug, status]) => answerFrom(surface, slug, status)),
  };
}

/** Sends a switch-on (`POST …/:slug/enable`) and returns the response unasserted. */
export function sendSwitchOn(
  baseUrl: string,
  actor: ActCaller,
  unit: ConsentActUnit,
  slug: string,
  body: Record<string, unknown>,
): request.Test {
  return request(baseUrl)
    .post(`${unitPluginsPath(unit)}/${slug}/enable`)
    .set(actor.headers)
    .send(body);
}

/** Sends a toggle (`POST …/:slug/consent/toggle`) and returns the response unasserted. */
export function sendToggle(
  baseUrl: string,
  actor: ActCaller,
  unit: ConsentActUnit,
  slug: string,
  body: Record<string, unknown>,
): request.Test {
  return request(baseUrl)
    .post(`${unitPluginsPath(unit)}/${slug}/consent/toggle`)
    .set(actor.headers)
    .send(body);
}

/** Sends a review (`POST …/:slug/consent/review`) and returns the response unasserted. */
export function sendReview(
  baseUrl: string,
  actor: ActCaller,
  unit: ConsentActUnit,
  slug: string,
  body: Record<string, unknown>,
): request.Test {
  return request(baseUrl)
    .post(`${unitPluginsPath(unit)}/${slug}/consent/review`)
    .set(actor.headers)
    .send(body);
}

/** One `shownRisks` entry of an install or approval body (#1336). */
export interface ShownRiskBody {
  readonly permissionSlug: string;
  readonly riskLevel: RiskLevel;
}

/** A requested permission as an install or approval read lists it: the fields `shownRisks` is built from. */
export interface ReadCheck {
  readonly slug: string;
  readonly consentScope: string;
  readonly riskLevel: RiskLevel | null;
}

/**
 * An install's or approval's `shownRisks`, read off the checks its read listed
 * (#1336): every server-scope one with a risk to show.
 */
export function shownServerRisks(checks: readonly ReadCheck[]): ShownRiskBody[] {
  return checks.flatMap((check) =>
    check.consentScope === 'server' && check.riskLevel !== null
      ? [{ permissionSlug: check.slug, riskLevel: check.riskLevel }]
      : [],
  );
}

/**
 * The `shownRisks` an approval of `slug` sends, read off the staged-update
 * read the way a client reads it (#1336). Empty when that read is refused: the
 * approval is then refused for the same reason before any risk is compared,
 * and a spec asserting that refusal should not fail on the read instead.
 */
export async function readStagedShownRisks(baseUrl: string, actor: ActCaller, slug: string): Promise<ShownRiskBody[]> {
  const response = await request(baseUrl).get(`/api/plugins/${slug}/update/pending`).set(actor.headers);

  return response.status === 200 ? shownServerRisks(response.body.presentation.checks) : [];
}

/**
 * The `shownRisks` an install of `sha256` sends, read off the artifact read
 * the way a client reads it (#1336). Empty when that read is refused, for the
 * reason `readStagedShownRisks` gives.
 */
export async function readArtifactShownRisks(
  baseUrl: string,
  actor: ActCaller,
  sha256: string,
): Promise<ShownRiskBody[]> {
  const response = await request(baseUrl).get(`/api/plugins/artifacts/${sha256}`).set(actor.headers);

  return response.status === 200 ? shownServerRisks(response.body.checks) : [];
}
