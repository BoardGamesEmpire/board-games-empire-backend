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
 * The unit an act is addressed to: a household, or the signed-in user.
 *
 * The two route families differ only in their prefix, so a helper takes the
 * unit rather than a path, and a spec cannot pair a household's surface with
 * the user's act route by accident.
 */
export type ConsentActUnit = { readonly householdId: string } | 'me';

/** The plugins route prefix for a unit. */
export function unitPluginsPath(unit: ConsentActUnit): string {
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
