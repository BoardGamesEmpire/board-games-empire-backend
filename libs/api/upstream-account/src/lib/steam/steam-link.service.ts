import { AuthService } from '@bge/auth';
import { Upstream } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Http } from '@status/codes';
import { httpAddress } from '../http-address';
import { UpstreamAccountErrorCode } from '../upstream-account.constants';
import { UpstreamAccountService } from '../upstream-account.service';
import { UPSTREAM_KEYS } from '../upstream-keys';
import type { SteamSignInDto } from './dto/steam-sign-in-response.dto';
import type { SteamVerification } from './steam-openid';
import { SteamOpenIdVerifier, steamSignInUrl } from './steam-openid';
import { STEAM_PROFILE_URL_PREFIX } from './steam-openid.constants';
import type { PendingSteamSignIn } from './steam-sign-in.store';
import { STEAM_SIGN_IN_LIFETIME_MINUTES, SteamSignInStore } from './steam-sign-in.store';

/**
 * Where Steam sends the browser back to: `SteamLinkController`'s return route,
 * under the api's global prefix (#935).
 */
export const STEAM_RETURN_PATH = '/api/users/me/upstream-accounts/steam/return';

/**
 * `authUrl` as the base of this server's own addresses: its path kept, as
 * better-auth keeps it for the sign-in providers' callbacks, so a server
 * behind a proxy at a sub-path gets Steam's return there too. A trailing
 * slash, a query and a fragment are dropped (#935).
 */
function serverBase(authUrl: string): string {
  const base = new URL(authUrl);
  base.search = '';
  base.hash = '';

  return base.toString().replace(/\/+$/, '');
}

/** What Steam's return brought back, as the return route received it (#935). */
export interface SteamSignInReturn {
  /** The return's whole query, Steam's `openid.*` fields among it, unvalidated. */
  query: Readonly<Record<string, unknown>>;

  /** The registered user whose session the browser came back in: null for none, an API key or an anonymous user. */
  sessionUserId: string | null;

  /** The query's `state`, when it is a single string. */
  state: string | null;
}

/** A return whose state was found: the pending sign-in it ends is known. */
type TakenSteamSignInReturn = SteamSignInReturn & { state: string };

/** The codes a return can send the browser back with. */
type SteamLinkRefusalCode = (typeof UpstreamAccountErrorCode)[
  'AlreadyLinked' | 'Cancelled' | 'Failed' | 'NotVerified' | 'SessionMismatch' | 'Taken' | 'Unreachable'];

/** How a return was settled: linked, or the code of why not. */
type SteamLinkOutcome = { error: SteamLinkRefusalCode } | { result: 'linked' };

/** The code each way the verifier refuses an answer is sent back with. */
const VERIFICATION_REFUSAL_CODES = {
  cancelled: UpstreamAccountErrorCode.Cancelled,
  'not-verified': UpstreamAccountErrorCode.NotVerified,
  unreachable: UpstreamAccountErrorCode.Unreachable,
} as const satisfies Record<Extract<SteamVerification, { ok: false }>['reason'], SteamLinkRefusalCode>;

/** The refusals storing the account can answer that a return sends back as codes; anything else is a fault. */
const STORE_REFUSAL_CODES: ReadonlySet<string> = new Set<SteamLinkRefusalCode>([
  UpstreamAccountErrorCode.AlreadyLinked,
  UpstreamAccountErrorCode.Taken,
]);

function isStoreRefusalCode(code: string): code is SteamLinkRefusalCode {
  return STORE_REFUSAL_CODES.has(code);
}

/**
 * The address a return sends the browser to (#935): `returnTo`, the address
 * the client gave when it started, which was checked then against the
 * trusted origins. Only `upstreamAccount=steam` and either `result=linked` or
 * `error=<code>` are written onto it, through `URL.searchParams`, replacing a
 * `result` or `error` it already carried. Nothing from Steam's answer or the
 * return's query reaches it.
 */
function linkResultAddress(returnTo: string, outcome: SteamLinkOutcome): string {
  const address = new URL(returnTo);
  address.searchParams.delete('result');
  address.searchParams.delete('error');
  address.searchParams.set('upstreamAccount', UPSTREAM_KEYS[Upstream.Steam]);

  if ('error' in outcome) {
    address.searchParams.set('error', outcome.error);
  } else {
    address.searchParams.set('result', outcome.result);
  }

  return address.toString();
}

/**
 * Linking a Steam account through Steam sign-in (#935).
 *
 * Starting keeps a pending sign-in under a single-use state for the user and
 * answers Steam's sign-in address. Its realm, the site Steam shows the user,
 * is the origin of this server's own address, the `auth.url` config (never a
 * request's `Host`), and its return address is the return route under that
 * address, path included, with the state on it.
 *
 * The return uses the state up before anything else, so any arrival, even
 * one refused, ends the sign-in. It then needs the browser to have come back
 * in the session of the user who started it: the state alone could have been
 * handed to someone else, and the session alone could be handed someone
 * else's Steam answer. Only then is Steam's answer verified and the account
 * stored, verified, since Steam's signature proves the SteamID. Once the state
 * is used up, every outcome sends the browser back to the client: a fault the
 * return has no code of its own for is logged and sent back as
 * `UPSTREAM_LINK_FAILED`.
 */
@Injectable()
export class SteamLinkService {
  private readonly logger = new Logger(SteamLinkService.name);

  /** Where clients reach this server, `auth.url` with no trailing slash: the base the return address is built on. */
  private readonly base: string;

  /** This server's origin: the sign-in's realm, which every address under {@link base} sits under. */
  private readonly origin: string;

  constructor(
    private readonly upstreamAccounts: UpstreamAccountService,
    private readonly signIns: SteamSignInStore,
    private readonly verifier: SteamOpenIdVerifier,
    private readonly auth: AuthService,
    config: ConfigService,
  ) {
    this.base = serverBase(config.getOrThrow<string>('auth.url'));
    this.origin = new URL(this.base).origin;
  }

  /**
   * Starts a Steam sign-in for `userId`, replacing one they have pending,
   * once `returnTo` is an absolute http or https address at a trusted origin
   * (else 400 `UPSTREAM_LINK_RETURN_ADDRESS_REFUSED`), a DataGateway declaring
   * Steam is usable for the link (else 409 `UPSTREAM_NOT_LINKABLE`), and the user has no
   * Steam account (else 409 `UPSTREAM_ACCOUNT_ALREADY_LINKED`). The answer
   * carries the privacy policy in the user's language (#934), read before the
   * sign-in starts so a failed read replaces nothing.
   */
  async startSignIn(userId: string, returnTo: string, acceptLanguage: string | undefined): Promise<SteamSignInDto> {
    const address = await this.trustedReturnAddress(returnTo);

    await this.upstreamAccounts.linkDataGateway(Upstream.Steam);
    await this.upstreamAccounts.assertNotLinked(userId, Upstream.Steam);
    const privacyPolicy = await this.upstreamAccounts.privacyPolicy(userId, acceptLanguage);
    const { state, expiresAt } = await this.signIns.start({ userId, returnTo: address });

    return {
      url: steamSignInUrl(this.returnUrl(state), this.origin),
      expiresAt: expiresAt.toISOString(),
      privacyPolicy,
    };
  }

  /**
   * Settles Steam's return and answers the address to send the browser to:
   * the pending sign-in's `returnTo`, with the result. A return whose state is
   * missing, unknown, expired or already used has no `returnTo` to go to, and
   * answers 400 `UPSTREAM_LINK_EXPIRED` instead. Any other failure, once the
   * state is used up, is logged and sent back as `UPSTREAM_LINK_FAILED`: the
   * browser is never left on an error answer from this server.
   */
  async finishSignIn(signInReturn: SteamSignInReturn): Promise<string> {
    const { state } = signInReturn;
    const pending = state === null ? null : await this.signIns.take(state);
    if (state === null || pending === null) {
      throw new CodedHttpException(
        Http.BadRequest,
        UpstreamAccountErrorCode.Expired,
        t('errors.upstream_account.link_expired', {
          upstream: Upstream.Steam,
          minutes: STEAM_SIGN_IN_LIFETIME_MINUTES,
        }),
      );
    }

    let outcome: SteamLinkOutcome;
    try {
      outcome = await this.settle(pending, { ...signInReturn, state });
    } catch (error) {
      // The state, the SteamID and the return address stay out of the log. A
      // Prisma error's message and stack print the call's arguments, so it is
      // logged by name and code only.
      const fault = error instanceof Error ? error : new Error(String(error));
      const failed = `A Steam sign-in's return for user ${pending.userId} failed, so nothing was linked`;

      if (fault.name.startsWith('PrismaClient')) {
        const code = 'code' in fault && typeof fault.code === 'string' ? ` (${fault.code})` : '';
        this.logger.error(`${failed}: ${fault.name}${code}`);
      } else {
        this.logger.error(`${failed}: ${fault.message}`, fault.stack);
      }

      outcome = { error: UpstreamAccountErrorCode.Failed };
    }

    return linkResultAddress(pending.returnTo, outcome);
  }

  /** The checks a return passes, in order, once its state is used up. */
  private async settle(
    pending: PendingSteamSignIn,
    { query, sessionUserId, state }: TakenSteamSignInReturn,
  ): Promise<SteamLinkOutcome> {
    if (sessionUserId !== pending.userId) {
      this.logger.warn(
        `Refused a Steam sign-in's return: user ${pending.userId} started it, and it came back ` +
          (sessionUserId === null ? "with no registered user's session" : `in the session of user ${sessionUserId}`),
      );

      return { error: UpstreamAccountErrorCode.SessionMismatch };
    }

    const verification = await this.verifier.verify(query, this.returnUrl(state));
    if (!verification.ok) {
      return { error: VERIFICATION_REFUSAL_CODES[verification.reason] };
    }

    // The DataGateway is not re-checked here on purpose: disabling one leaves
    // existing upstream accounts linked, so a sign-in finishing within its
    // lifetime is consistent with that (#935).
    try {
      await this.upstreamAccounts.create({
        userId: pending.userId,
        upstream: Upstream.Steam,
        externalId: verification.steamId,
        profileUrl: `${STEAM_PROFILE_URL_PREFIX}${verification.steamId}`,
        displayName: null,
        verified: true,
      });
    } catch (error) {
      if (error instanceof CodedHttpException && isStoreRefusalCode(error.code)) {
        return { error: error.code };
      }

      throw error;
    }

    return { result: 'linked' };
  }

  /**
   * The address Steam sends the browser back to for `state`. The verifier
   * compares an answer's `return_to` with it by exact string, so the start
   * and the return both build it here.
   */
  private returnUrl(state: string): string {
    const address = new URL(`${this.base}${STEAM_RETURN_PATH}`);
    address.searchParams.set('state', state);

    return address.toString();
  }

  /**
   * `returnTo` as it is kept and later redirected to, once it is an absolute
   * http or https address the auth service trusts. The address checked is the
   * parsed one, the same string that is kept.
   */
  private async trustedReturnAddress(returnTo: string): Promise<string> {
    const address = httpAddress(returnTo);
    if (address !== null && (await this.auth.isTrustedReturnAddress(address.href))) {
      return address.href;
    }

    throw new CodedHttpException(
      Http.BadRequest,
      UpstreamAccountErrorCode.ReturnAddressRefused,
      t('errors.upstream_account.link_return_address_refused', { upstream: Upstream.Steam }),
    );
  }
}
