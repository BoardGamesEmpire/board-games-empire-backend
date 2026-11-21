import { Logger } from '@nestjs/common';
import { RelyingParty } from 'openid';
import * as z from 'zod';
import type { SteamOpenIdEndpoints } from './steam-openid.constants';
import {
  OPENID_2_NAMESPACE,
  OPENID_IDENTIFIER_SELECT,
  OPENID_REQUIRED_SIGNED_FIELDS,
  STEAM_OPENID_ENDPOINTS,
  STEAM_VERIFY_TIMEOUT_MS,
} from './steam-openid.constants';

/** What checking the answer a Steam sign-in sent back found (#935). */
export type SteamVerification =
  { ok: false; reason: 'cancelled' | 'not-verified' | 'unreachable' } | { ok: true; steamId: string };

/**
 * The address that starts a Steam sign-in (#935). It is built here, not by the
 * `openid` library, whose `authenticate` first discovers the endpoint over the
 * network, so starting a link makes no request. The user picks their account
 * at Steam (`identifier_select`), and Steam sends the browser back to
 * `returnUrl`, which sits under `realm`, the site Steam shows the user.
 */
export function steamSignInUrl(
  returnUrl: string,
  realm: string,
  endpoints: SteamOpenIdEndpoints = STEAM_OPENID_ENDPOINTS,
): string {
  const address = new URL(endpoints.endpoint);
  address.searchParams.set('openid.ns', OPENID_2_NAMESPACE);
  address.searchParams.set('openid.mode', 'checkid_setup');
  address.searchParams.set('openid.return_to', returnUrl);
  address.searchParams.set('openid.realm', realm);
  address.searchParams.set('openid.identity', OPENID_IDENTIFIER_SELECT);
  address.searchParams.set('openid.claimed_id', OPENID_IDENTIFIER_SELECT);

  return address.toString();
}

/** An answer's query, every value a single string: a repeated or nested value fails. */
const singleStrings = z.record(z.string(), z.string());

/** A SteamID64, as the claimed id ends with it. */
const STEAM_ID = /^\d{17}$/;

/**
 * The messages `openid@2.0.19` calls back with when a request it made got no
 * usable answer: discovery of the claimed id found nothing (every request
 * failed, or the document named no endpoint), or `check_authentication`
 * answered other than 200, or not at all. Any other message is a refusal of
 * the answer. A message a later version words differently counts as a
 * refusal, which links nothing either, and fails the spec's unreachable cases.
 */
const UNREACHABLE_MESSAGES: ReadonlySet<string> = new Set([
  'No OpenID provider was discovered for the asserted claimed identifier',
  'Invalid assertion response from provider',
]);

/** An answer that passed the checks made before the library runs. */
interface CheckedAnswer {
  /** The claimed id, which the library's confirmation must name. */
  readonly claimedId: string;

  /** The answer's fields, each a single string. */
  readonly fields: Readonly<Record<string, string>>;

  /** The SteamID the claimed id ends with. */
  readonly steamId: string;
}

/** Why an answer was refused before the library ran, for the log. Never a user-facing message. */
interface Refusal {
  readonly refusal: string;
}

function refused(reason: 'cancelled' | 'not-verified' | 'unreachable'): SteamVerification {
  return { ok: false, reason };
}

/**
 * Whether `openid.signed` names every field a positive answer must sign, and a
 * signature is present (OpenID 2.0, sections 10.1 and 11.4). The library
 * checks neither: it passes the list to Steam as given.
 */
function signsRequiredFields(fields: Readonly<Record<string, string>>): boolean {
  const signed: string | undefined = fields['openid.signed'];
  const signature: string | undefined = fields['openid.sig'];
  if (signed === undefined || signature === undefined || signature === '') {
    return false;
  }

  const names = new Set(signed.split(','));

  return OPENID_REQUIRED_SIGNED_FIELDS.every((name) => names.has(name));
}

/**
 * The address the library reads the answer from: the return address with the
 * answer's OpenID fields as its query, and nothing else. The library reads
 * only the query, and posts every field of it back to Steam, so the sign-in's
 * own `state` stays here.
 */
function assertionUrl(returnUrl: string, fields: Readonly<Record<string, string>>): string {
  const address = new URL(returnUrl);
  address.search = '';
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('openid.')) {
      address.searchParams.append(key, value);
    }
  }

  return address.toString();
}

/**
 * Checks the answer a Steam sign-in sends back (#935): the `openid` library
 * (havard/node-openid) verifies it in stateless mode, behind strict checks of
 * its own.
 *
 * Those checks come first, and a refusal by any of them makes no request,
 * because the library contacts whatever the answer names. It discovers the
 * claimed id with a GET, then posts `check_authentication` to the answer's
 * `op_endpoint`, and a host the answer named would be asked to vouch for it.
 * So the answer has to name Steam's endpoint and a claimed id of Steam's form,
 * come back to the address this sign-in sent, and sign every field it must.
 *
 * The library's requests go out through its own HTTP client (axios), not
 * `SecureHttpService`, so the outbound HTTP policy does not see them, as it
 * does not see better-auth's requests to sign-in providers; #982 decides for
 * both. They have no timeout, so the check races `timeoutMs`, and a request
 * that outlives it is left to end on its own: the library has no way to cancel
 * one. The library can call back twice (an error answer to its POST reaches
 * its callback once with the answer and once with axios's error), so the
 * outcome is the first.
 *
 * Its constructor takes plain values, with Steam's as the defaults, so a
 * module provides it through a factory rather than by injection.
 */
export class SteamOpenIdVerifier {
  private readonly logger = new Logger(SteamOpenIdVerifier.name);

  constructor(
    private readonly endpoints: SteamOpenIdEndpoints = STEAM_OPENID_ENDPOINTS,
    private readonly timeoutMs: number = STEAM_VERIFY_TIMEOUT_MS,
  ) {}

  /**
   * Whether `query`, the return route's raw query, is Steam's signed answer to
   * the sign-in that sent `returnUrl`, and the SteamID it proves if so. It
   * never rejects: every failure is an answer.
   */
  async verify(query: Readonly<Record<string, unknown>>, returnUrl: string): Promise<SteamVerification> {
    if (query['openid.mode'] === 'cancel') {
      return refused('cancelled');
    }

    const checked = this.check(query, returnUrl);
    if ('refusal' in checked) {
      this.logger.warn(`Refused a Steam sign-in answer without asking Steam: ${checked.refusal}`);

      return refused('not-verified');
    }

    return this.askSteam(checked, returnUrl);
  }

  /** The checks made before the library runs, in order. */
  private check(query: Readonly<Record<string, unknown>>, returnUrl: string): CheckedAnswer | Refusal {
    const parsed = singleStrings.safeParse(query);
    if (!parsed.success) {
      return { refusal: 'a query value is repeated or is not a string' };
    }

    const fields: Readonly<Record<string, string>> = parsed.data;
    if (fields['openid.mode'] !== 'id_res') {
      return { refusal: 'openid.mode is not id_res' };
    }

    if (fields['openid.ns'] !== OPENID_2_NAMESPACE) {
      return { refusal: 'openid.ns is not OpenID 2.0' };
    }

    if (fields['openid.op_endpoint'] !== this.endpoints.endpoint) {
      return { refusal: "openid.op_endpoint is not Steam's endpoint" };
    }

    const claimedId: string | undefined = fields['openid.claimed_id'];
    if (claimedId === undefined || claimedId !== fields['openid.identity']) {
      return { refusal: 'openid.claimed_id is missing or differs from openid.identity' };
    }

    const steamId = this.steamIdOf(claimedId);
    if (steamId === null) {
      return { refusal: "openid.claimed_id does not have the form of Steam's" };
    }

    if (fields['openid.return_to'] !== returnUrl) {
      return { refusal: 'openid.return_to is not the address this sign-in sent' };
    }

    if (!signsRequiredFields(fields)) {
      return { refusal: 'the signature does not cover every field it must' };
    }

    return { claimedId, fields, steamId };
  }

  /** The SteamID a claimed id of Steam's form ends with, or null for any other claimed id. */
  private steamIdOf(claimedId: string): string | null {
    if (!claimedId.startsWith(this.endpoints.claimedIdPrefix)) {
      return null;
    }

    const steamId = claimedId.slice(this.endpoints.claimedIdPrefix.length);

    return STEAM_ID.test(steamId) ? steamId : null;
  }

  /**
   * Has the library verify a checked answer: it discovers the claimed id, then
   * asks Steam to check the signature. Settles once, on the first of the
   * library's answer, its throw, or the timeout.
   */
  private askSteam({ claimedId, fields, steamId }: CheckedAnswer, returnUrl: string): Promise<SteamVerification> {
    return new Promise((resolve) => {
      let settled = false;

      // Called only once `timer` below is set: by the timer, the library or
      // the catch, all of which run after it.
      const settle = (verification: SteamVerification, detail: string): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        if (!verification.ok) {
          this.logger.warn(`Steam sign-in answer not verified (${verification.reason}): ${detail}`);
        }

        resolve(verification);
      };

      const timer = setTimeout(
        () => settle(refused('unreachable'), `no answer within ${this.timeoutMs} ms`),
        this.timeoutMs,
      );

      try {
        const relyingParty = new RelyingParty(
          returnUrl,
          new URL(returnUrl).origin,
          /* stateless */ true,
          /* strict */ true,
          [],
        );
        relyingParty.verifyAssertion(assertionUrl(returnUrl, fields), (error, result) => {
          if (error) {
            settle(refused(UNREACHABLE_MESSAGES.has(error.message) ? 'unreachable' : 'not-verified'), error.message);
            return;
          }

          if (result?.authenticated !== true || result.claimedIdentifier !== claimedId) {
            settle(refused('not-verified'), 'the library did not confirm the claimed id that was checked');
            return;
          }

          settle({ ok: true, steamId }, 'verified');
        });
      } catch (error) {
        settle(refused('not-verified'), error instanceof Error ? error.message : String(error));
      }
    });
  }
}
