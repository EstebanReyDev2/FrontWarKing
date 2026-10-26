import type { NewsItem } from "@openfront/shared/ApiSchemas";
import {
  IdentityTokenAudiencesResponseSchema,
  IdentityTokenResponse,
  IdentityTokenResponseSchema,
  NewsItemSchema,
  PaymentsCheckoutResponse,
  PaymentsCheckoutResponseSchema,
  PaymentsHandoff,
  PaymentsKind,
  PaymentsKindSchema,
  PaymentsProvider,
  PlayerGameModeFilter,
  PlayerGameTypeFilter,
  PlayerProfile,
  PlayerProfileSchema,
  PublicCreatorSchema,
  PublicPlayerGamesResponse,
  PublicPlayerGamesResponseSchema,
  PutCreatorResponseSchema,
  PutUsernameResponse,
  PutUsernameResponseSchema,
  RankedLeaderboardResponse,
  RankedLeaderboardResponseSchema,
  SteamFinalizeResponseSchema,
  SteamOrderResolution,
  UserMeResponse,
  UserMeResponseSchema,
  VisibilityResponseSchema,
} from "@openfront/shared/ApiSchemas";
import {
  AnalyticsRecord,
  ArchivedAnalyticsRecordSchema,
  GameInfo,
} from "@openfront/shared/WireSchemas";
import newsItemsFallback from "resources/news.json";
import { z } from "zod";
import { getApiBase, getAudience } from "./ApiBase";
import {
  getAuthHeader,
  getPlayToken,
  isSessionActive,
  logOut,
  rememberPublicId,
  userAuth,
} from "./Auth";
import { ClientEnv } from "./ClientEnv";
import { ensureServerList } from "./ServerList";
import { UserSettings } from "./UserSettings";

export async function fetchPlayerById(
  playerId: string,
): Promise<PlayerProfile | false> {
  try {
    const userAuthResult = await userAuth();
    if (!userAuthResult) return false;
    const { jwt } = userAuthResult;

    const url = `${getApiBase()}/player/${encodeURIComponent(playerId)}`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${jwt}`,
      },
    });

    if (res.status !== 200) {
      console.warn(
        "fetchPlayerById: unexpected status",
        res.status,
        res.statusText,
      );
      return false;
    }

    const json = await res.json();
    const parsed = PlayerProfileSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("fetchPlayerById: Zod validation failed", parsed.error);
      return false;
    }

    return parsed.data;
  } catch (err) {
    console.warn("fetchPlayerById: request failed", err);
    return false;
  }
}

// GET /public/player/:publicId — public player profile (stats tree). No auth,
// so logged-out visitors can view shared profiles.
export async function fetchPublicPlayerProfile(
  publicId: string,
): Promise<PlayerProfile | false> {
  try {
    const url = `${getApiBase()}/public/player/${encodeURIComponent(publicId)}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (res.status !== 200) {
      console.warn(
        "fetchPublicPlayerProfile: unexpected status",
        res.status,
        res.statusText,
      );
      return false;
    }

    const json = await res.json();
    const parsed = PlayerProfileSchema.safeParse(json);
    if (!parsed.success) {
      console.warn(
        "fetchPublicPlayerProfile: Zod validation failed",
        parsed.error,
      );
      return false;
    }

    return parsed.data;
  } catch (err) {
    console.warn("fetchPublicPlayerProfile: request failed", err);
    return false;
  }
}

// GET /public/player/:publicId/games — keyset-paginated personal game history.
// Public (no auth). `filter` (mode bucket) and `type` (game-type split) are
// orthogonal; `cursor` is the opaque token from the previous response's
// nextCursor — round-trip verbatim, never construct it.
export async function fetchPublicPlayerGames(
  publicId: string,
  opts: {
    filter?: PlayerGameModeFilter;
    type?: PlayerGameTypeFilter;
    cursor?: string;
  } = {},
): Promise<PublicPlayerGamesResponse | { error: "failed" }> {
  try {
    const url = new URL(
      `${getApiBase()}/public/player/${encodeURIComponent(publicId)}/games`,
    );
    if (opts.filter) url.searchParams.set("filter", opts.filter);
    if (opts.type) url.searchParams.set("type", opts.type);
    if (opts.cursor) url.searchParams.set("cursor", opts.cursor);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(
        "fetchPublicPlayerGames: unexpected status",
        res.status,
        res.statusText,
      );
      return { error: "failed" };
    }

    const json = await res.json();
    const parsed = PublicPlayerGamesResponseSchema.safeParse(json);
    if (!parsed.success) {
      console.warn(
        "fetchPublicPlayerGames: Zod validation failed",
        parsed.error,
      );
      return { error: "failed" };
    }
    return parsed.data;
  } catch (err) {
    console.warn("fetchPublicPlayerGames: request failed", err);
    return { error: "failed" };
  }
}

let __userMe: Promise<UserMeResponse | false> | null = null;

// The profile outlives the session it describes unless this is dropped with
// it: getUserMe answers from the cache before it checks authentication, so a
// consumer calling it after a background logout would read the expired
// account straight back. Handled here rather than in Auth, which cannot
// import this module — the dependency runs the other way.
document.addEventListener("session-cleared", () => invalidateUserMe());
/**
 * True for the rejection AbortSignal.timeout (or an explicit abort) produces.
 * Deliberately narrow: a client-imposed deadline is the one failure that says
 * nothing at all about the account, so it is the one worth retrying.
 */
function isAbortError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * One /users/@me round trip, with no memoisation of any kind.
 *
 * `aborted` distinguishes the one failure that concluded nothing about the
 * account (a deadline we imposed ourselves) from every other falsy answer,
 * which is a conclusion. Only getUserMe acts on it; see the un-caching rule
 * there.
 */
async function requestUserMe(): Promise<{
  profile: UserMeResponse | false;
  aborted: boolean;
}> {
  try {
    const userAuthResult = await userAuth();
    if (!userAuthResult) return { profile: false, aborted: false };
    const { jwt, claims } = userAuthResult;

    // Get the user object. Bounded like the other auth calls (see
    // Auth.ts doSteamLogin) because getUserMe memoises the promise around
    // this: a response that never settles is not one slow call, it pins
    // __userMe on a forever-pending promise and every later getUserMe() in
    // the session — cosmetics, store, inventory, the multiplayer join path —
    // awaits that same promise. An abort lands in the catch below, which
    // returns false, the same answer a signed-out player already gets.
    const response = await fetch(getApiBase() + "/users/@me", {
      headers: {
        authorization: `Bearer ${jwt}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) {
      // Only when the session that issued this request is still the current
      // one — the same guard, and the same reason, as the setPlayerId one
      // below. logOut() POSTs /auth/logout with credentials, revoking
      // whatever refresh cookie is live *now*, so a 401 that merely reports
      // the death of a session already replaced (sign-out then sign-in while
      // this was in flight) would end the session that replaced it, signing
      // out the player who just signed in. A 401 for the session that is
      // still current is a genuine conclusion about it and still ends it.
      //
      // Clearing the session announces itself (see clearLocalSession), so
      // consumers holding account state don't mistake this for the
      // transient failure the `false` below also represents.
      if (isSessionActive(claims.sub)) {
        await logOut();
      }
      return { profile: false, aborted: false };
    }
    if (response.status !== 200) return { profile: false, aborted: false };
    const body = await response.json();
    const result = UserMeResponseSchema.safeParse(body);
    if (!result.success) {
      const error = z.prettifyError(result.error);
      console.error("Invalid response", error);
      return { profile: false, aborted: false };
    }
    // Activate this player's cosmetic selections (and adopt any made while
    // logged out) before the profile is handed to callers — but not if the
    // session changed (logout, account switch) while the request was in
    // flight: a stale response must not reactivate the old player's scope.
    if (isSessionActive(claims.sub)) {
      const publicId = result.data.player.publicId;
      rememberPublicId(claims.sub, publicId);
      UserSettings.setPlayerId(publicId);
    }
    return { profile: result.data, aborted: false };
  } catch (e) {
    return { profile: false, aborted: isAbortError(e) };
  }
}

export async function getUserMe(): Promise<UserMeResponse | false> {
  if (__userMe !== null) {
    return __userMe;
  }
  // A holder rather than a plain local so the body below can recognise its
  // own promise as the cached one. Filled in immediately after, which is
  // always before any await inside can resume.
  const attempt: { request?: Promise<UserMeResponse | false> } = {};
  attempt.request = (async () => {
    const { profile, aborted } = await requestUserMe();
    // Un-cache a timeout, and ONLY a timeout. Every other falsy answer is
    // a conclusion about the account — signed out, a 401, a rejected token
    // — and stays remembered; re-deriving those would put an /auth/refresh
    // behind every getUserMe() call for every logged-out player, which is
    // the storm, not the fix. A deadline we imposed ourselves concluded
    // nothing, so leaving it cached would strand a merely-slow connection
    // as "signed out" for the rest of the session: no player-scoped
    // settings, no cosmetics, no verified badge, recoverable only by
    // reloading. Same shape as fetchCosmetics, for the same reason.
    // Remembering an unreachable backend so the retry is not paid at full
    // price is OPE-403.
    //
    // Cleared here rather than from a .then on the request: this runs
    // before the promise resolves, so a caller awaiting it cannot observe
    // the timed-out answer still cached. attempt.request is always set by
    // now — this line can only be reached after an await.
    if (aborted && __userMe === attempt.request) {
      __userMe = null;
    }
    return profile;
  })();
  __userMe = attempt.request;
  return attempt.request;
}

export function invalidateUserMe() {
  __userMe = null;
}

export type DeleteAccountResult =
  // 204: deletion queued — the server deletes the account 24 hours later.
  | { ok: true }
  // 401: missing/unknown/expired refresh token — already logged out, and the
  // server cleared the cookie.
  | { ok: false; code: "logged_out" }
  // 403: refused by policy. `message` is the server's player-facing reason
  // (root player / banned account), shown as-is.
  | { ok: false; code: "forbidden"; message?: string }
  // 429: the global deletion rate limit (one per 20 minutes across all
  // players) — nothing was queued, try again later.
  | { ok: false; code: "rate_limited" }
  // Anything else: the client shows a "contact support" failure.
  | { ok: false; code: "failed" };

// DELETE /users/@me — queues the account for deletion; the server performs it
// 24 hours later, and only support can cancel in the meantime (there is no
// self-service cancel endpoint). The HttpOnly refresh cookie is the credential
// (same as /auth/logout), so no Authorization header. On 204 every session on
// every device is invalidated and the cookie is cleared — callers drop local
// auth state themselves and must NOT call /auth/logout afterwards. Signing in
// again during the 24 hours works but does not cancel the deletion.
export async function deleteAccount(): Promise<DeleteAccountResult> {
  try {
    const response = await fetch(`${getApiBase()}/users/@me`, {
      method: "DELETE",
      credentials: "include",
    });
    if (response.status === 401) {
      return { ok: false, code: "logged_out" };
    }
    if (response.status === 403) {
      const body = await response.json().catch(() => null);
      return {
        ok: false,
        code: "forbidden",
        message: typeof body?.message === "string" ? body.message : undefined,
      };
    }
    if (response.status === 429) {
      return { ok: false, code: "rate_limited" };
    }
    if (!response.ok) {
      console.error(
        "deleteAccount: request failed",
        response.status,
        response.statusText,
      );
      return { ok: false, code: "failed" };
    }
    return { ok: true };
  } catch (e) {
    console.error("deleteAccount: request failed", e);
    return { ok: false, code: "failed" };
  }
}

// POST /marketing/consent — record the player's marketing-email choice
// (client-driven consent). Called by the consent toast and account settings.
// Invalidates the cached /users/@me so the new decision is reflected on the
// next read. Returns true on success.
export async function setMarketingConsent(
  consented: boolean,
): Promise<boolean> {
  try {
    const response = await fetch(`${getApiBase()}/marketing/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({ consented }),
    });
    if (response.status === 401) {
      await logOut();
      return false;
    }
    if (!response.ok) {
      console.error(
        "setMarketingConsent: request failed",
        response.status,
        response.statusText,
      );
      return false;
    }
    invalidateUserMe();
    return true;
  } catch (e) {
    console.error("setMarketingConsent: request failed", e);
    return false;
  }
}

export type SetVisibilityResult =
  // 200: the stored setting, as the server echoes it.
  | { ok: true; hidden: boolean }
  // 401: the session is gone; logOut() has already run.
  | { ok: false; code: "logged_out" }
  // Anything else (400, 429, 5xx, network, unreadable body): nothing to act on
  // beyond "try again".
  | { ok: false; code: "failed" };

// PUT /users/@me/<setting> { hidden }: the one write path behind every privacy
// toggle, so each setter differs only in its endpoint. Idempotent: the body is
// the desired state. Invalidates the cached /users/@me on success so the next
// read reflects it.
async function putVisibility(
  setting: "search_visibility",
  hidden: boolean,
): Promise<SetVisibilityResult> {
  try {
    const response = await fetch(`${getApiBase()}/users/@me/${setting}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({ hidden }),
    });
    if (response.status === 401) {
      await logOut();
      return { ok: false, code: "logged_out" };
    }
    if (!response.ok) {
      console.error(
        `PUT ${setting}: request failed`,
        response.status,
        response.statusText,
      );
      return { ok: false, code: "failed" };
    }
    const parsed = VisibilityResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error(`PUT ${setting}: Zod validation failed`, parsed.error);
      return { ok: false, code: "failed" };
    }
    invalidateUserMe();
    return { ok: true, hidden: parsed.data.hidden };
  } catch (e) {
    console.error(`PUT ${setting}: request failed`, e);
    return { ok: false, code: "failed" };
  }
}

// "Keep my profile out of search engines" (the public profile page is served
// noindex).
export function setSearchVisibility(
  hidden: boolean,
): Promise<SetVisibilityResult> {
  return putVisibility("search_visibility", hidden);
}

// The sites a player can generate an identity token for. Fails closed: any
// error lands on an empty list, which hides the account-settings card.
export async function getIdentityTokenAudiences(): Promise<string[]> {
  const { audiences } = await getServedConfig(
    "public/identity_token/audiences",
    IdentityTokenAudiencesResponseSchema,
    { audiences: [] },
  );
  return audiences;
}

export type IdentityTokenResult =
  | { ok: true; data: IdentityTokenResponse }
  // 401: the session is gone.
  | { ok: false; code: "logged_out" }
  // 429: more than 10 requests/min from this IP.
  | { ok: false; code: "rate_limited" }
  | { ok: false; code: "failed" };

// POST /users/@me/identity_token — mint a 10-minute token proving which
// account the player owns, valid only on `audience`. Nothing is stored
// server-side and callers must not cache it: mint a fresh one per request.
export async function createIdentityToken(
  audience: string,
): Promise<IdentityTokenResult> {
  try {
    const response = await fetch(`${getApiBase()}/users/@me/identity_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({ audience }),
    });
    if (response.status === 401) {
      return { ok: false, code: "logged_out" };
    }
    if (response.status === 429) {
      return { ok: false, code: "rate_limited" };
    }
    if (!response.ok) {
      console.error(
        "createIdentityToken: request failed",
        response.status,
        response.statusText,
      );
      return { ok: false, code: "failed" };
    }
    const parsed = IdentityTokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error("createIdentityToken: invalid response", parsed.error);
      return { ok: false, code: "failed" };
    }
    return { ok: true, data: parsed.data };
  } catch (e) {
    console.error("createIdentityToken: request failed", e);
    return { ok: false, code: "failed" };
  }
}

export type UpdateUsernameResult =
  | { ok: true; data: PutUsernameResponse }
  | { ok: false; code: "invalid"; message?: string }
  | { ok: false; code: "profane" }
  | { ok: false; code: "taken" }
  // A subscriber asked for a bare name another subscriber holds. Nothing was
  // written and no cooldown was spent; resubmit with acceptSuffixed to take
  // the numbered form (spec, 10 Sept 2026).
  | { ok: false; code: "bare_taken"; base: string }
  | { ok: false; code: "cooldown"; retryAfterSeconds: number | null }
  | { ok: false; code: "failed" };

// PUT /users/@me/username — renames the account username. Every failure is
// atomic (no name change, no cooldown consumed). The surviving plain 409
// bodies ("name equals an existing public id" and "suffix space exhausted")
// map to "taken": the user remedy is the same — pick another name. A 409
// carrying code BARE_NAME_TAKEN maps to "bare_taken": the caller offers the
// numbered form and, on yes, calls again with `acceptSuffixed`. Invalidates
// the cached /users/@me on success so the next read reflects the new name.
//
// Against an API that predates the strict rule, a held bare name still comes
// back as a 200 with `bareClaim: "unavailable"` — a real rename that consumed
// the cooldown — so `ok: true` callers must still read `data.bareClaim` and
// say so (see UsernamePanel.warnBareClaimUnavailable).
export async function updateUsername(
  username: string,
  opts: { acceptSuffixed?: boolean } = {},
): Promise<UpdateUsernameResult> {
  try {
    const response = await fetch(`${getApiBase()}/users/@me/username`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify(
        opts.acceptSuffixed ? { username, acceptSuffixed: true } : { username },
      ),
    });
    if (response.status === 401) {
      await logOut();
      return { ok: false, code: "failed" };
    }
    if (response.status === 400) {
      const body = await response.json().catch(() => null);
      if (body?.code === "USERNAME_PROFANE") {
        return { ok: false, code: "profane" };
      }
      return {
        ok: false,
        code: "invalid",
        message: typeof body?.reason === "string" ? body.reason : undefined,
      };
    }
    if (response.status === 409) {
      const body = await response.json().catch(() => null);
      if (body?.code === "BARE_NAME_TAKEN") {
        return {
          ok: false,
          code: "bare_taken",
          base: typeof body.base === "string" ? body.base : username,
        };
      }
      return { ok: false, code: "taken" };
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      return {
        ok: false,
        code: "cooldown",
        retryAfterSeconds: Number.isFinite(seconds) ? seconds : null,
      };
    }
    if (!response.ok) {
      console.error(
        "updateUsername: request failed",
        response.status,
        response.statusText,
      );
      return { ok: false, code: "failed" };
    }
    const parsed = PutUsernameResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error("updateUsername: Zod validation failed", parsed.error);
      return { ok: false, code: "failed" };
    }
    invalidateUserMe();
    return { ok: true, data: parsed.data };
  } catch (e) {
    console.error("updateUsername: request failed", e);
    return { ok: false, code: "failed" };
  }
}

// GET /creators/code/:code — public lookup for a creator by their code
// (Creator Code programme), e.g. to preview/prefill an openfront.io/c/CODE
// share link before binding. No auth. 404 means the code doesn't resolve to
// any (active) creator; folds into null along with every other failure —
// callers can't act on the difference.
export async function getCreatorByCode(
  code: string,
): Promise<{ code: string; displayName: string } | null> {
  try {
    const response = await fetch(
      `${getApiBase()}/creators/code/${encodeURIComponent(code)}`,
      { headers: { Accept: "application/json" } },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      console.error(
        "getCreatorByCode: request failed",
        response.status,
        response.statusText,
      );
      return null;
    }
    const parsed = PublicCreatorSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error("getCreatorByCode: Zod validation failed", parsed.error);
      return null;
    }
    return { code: parsed.data.code, displayName: parsed.data.displayName };
  } catch (e) {
    console.error("getCreatorByCode: request failed", e);
    return null;
  }
}

export type SetCreatorCodeResult =
  | { ok: true; creator: { code: string; displayName: string } }
  | {
      ok: false;
      code:
        | "invalid"
        | "not_found"
        | "self_referral"
        | "failed"
        | "rate_limited";
    }
  | { ok: false; code: "cooldown"; retryAfterSeconds: number | null };

const SET_CREATOR_CODE_ERROR_CODES = [
  "invalid",
  "not_found",
  "self_referral",
] as const;
type SetCreatorCodeErrorCode = (typeof SET_CREATOR_CODE_ERROR_CODES)[number];
function isSetCreatorCodeErrorCode(
  value: unknown,
): value is SetCreatorCodeErrorCode {
  return (
    typeof value === "string" &&
    (SET_CREATOR_CODE_ERROR_CODES as readonly string[]).includes(value)
  );
}

// PUT /users/@me/creator {code} — binds (or switches) the caller's supported
// creator (Creator Code programme). One bind/switch consumes a 7-day change
// cooldown before the next one is allowed; re-confirming the SAME creator is
// a no-op 200 that does not consume it (handled server-side).
//
// This endpoint answers its own failures with a body carrying `code` — a 400
// for invalid/not_found/self_referral, and its own 429 for the cooldown
// (with a Retry-After header). But it also sits behind a SEPARATE, shared
// 10s debounce in front of every mutating endpoint, which can ALSO 429 —
// and that response carries no `ok`/`code` fields at all. Only trust
// `code === "cooldown"` to mean the real 7-day cooldown; any other 429 (the
// debounce, or anything unrecognized) maps to "rate_limited".
//
// Invalidates the cached /users/@me on success so the bound creator (and the
// fresh cooldown) show up on the next read.
export async function setCreatorCode(
  code: string,
): Promise<SetCreatorCodeResult> {
  try {
    const response = await fetch(`${getApiBase()}/users/@me/creator`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({ code }),
    });
    if (response.status === 401) {
      await logOut();
      return { ok: false, code: "failed" };
    }
    if (response.status === 400) {
      const body = await response.json().catch(() => null);
      const bodyCode: unknown = body?.code;
      return {
        ok: false,
        code: isSetCreatorCodeErrorCode(bodyCode) ? bodyCode : "failed",
      };
    }
    if (response.status === 429) {
      const body = await response.json().catch(() => null);
      if (body?.code === "cooldown") {
        const retryAfter = response.headers.get("Retry-After");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        return {
          ok: false,
          code: "cooldown",
          retryAfterSeconds: Number.isFinite(seconds) ? seconds : null,
        };
      }
      return { ok: false, code: "rate_limited" };
    }
    if (!response.ok) {
      console.error(
        "setCreatorCode: request failed",
        response.status,
        response.statusText,
      );
      return { ok: false, code: "failed" };
    }
    const parsed = PutCreatorResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.error("setCreatorCode: Zod validation failed", parsed.error);
      return { ok: false, code: "failed" };
    }
    invalidateUserMe();
    return { ok: true, creator: parsed.data.creator };
  } catch (e) {
    console.error("setCreatorCode: request failed", e);
    return { ok: false, code: "failed" };
  }
}

export type ClearCreatorCodeResult =
  | { ok: true }
  | { ok: false; code: "rate_limited" | "failed" };

// DELETE /users/@me/creator — unbinds the caller's supported creator, if any
// (Creator Code programme). Always safe: unbinding is never gated by the
// 7-day change cooldown (that cooldown only governs the NEXT bind, whose
// anchor moves to "now" on unbind) — so unlike setCreatorCode's 429, a 429
// here can only ever be the shared 10s mutation debounce, never a real
// cooldown, and maps straight to "rate_limited". Invalidates the cached
// /users/@me on success so the cleared binding shows up on the next read.
export async function clearCreatorCode(): Promise<ClearCreatorCodeResult> {
  try {
    const response = await fetch(`${getApiBase()}/users/@me/creator`, {
      method: "DELETE",
      headers: {
        Authorization: await getAuthHeader(),
      },
    });
    if (response.status === 401) {
      await logOut();
      return { ok: false, code: "failed" };
    }
    if (response.status === 429) {
      return { ok: false, code: "rate_limited" };
    }
    if (!response.ok) {
      console.error(
        "clearCreatorCode: request failed",
        response.status,
        response.statusText,
      );
      return { ok: false, code: "failed" };
    }
    invalidateUserMe();
    return { ok: true };
  } catch (e) {
    console.error("clearCreatorCode: request failed", e);
    return { ok: false, code: "failed" };
  }
}

export async function createCustomCurrencyCheckout(
  hardAmount: number,
): Promise<string | false> {
  try {
    const response = await fetch(
      `${getApiBase()}/stripe/create-custom-currency-checkout`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: await getAuthHeader(),
        },
        body: JSON.stringify({
          hardAmount: hardAmount,
          hostname: window.location.origin,
        }),
      },
    );
    if (!response.ok) {
      console.error(
        "createCustomCurrencyCheckout: request failed",
        response.status,
        response.statusText,
      );
      return false;
    }
    const json = await response.json();
    return json.url;
  } catch (e) {
    console.error("createCustomCurrencyCheckout: request failed", e);
    return false;
  }
}

// What the caller wants to buy. `provider` is chosen explicitly by the client
// (see paymentsProvider() in Payments.ts) — the server never infers the rail.
// Exactly one identifier travels with each kind, and it is always a NAME: the
// endpoint has no priceId, because a Steam-only listing has no Stripe price.
//
// `handoffs` lists the handoffs this client can perform, so the server may
// answer with any of them. Omitted means the pre-inline set ("redirect" /
// "client_overlay") — and a server that predates the field ignores it and
// answers "redirect", which every caller must still handle. That is the
// upgrade path: the inline flow degrades to the redirect flow, never to a
// dead button.
export type PaymentsCheckoutRequest = (
  | { kind: "currency_pack"; packName: string }
  | { kind: "custom_currency"; hardAmount: number }
  | { kind: "subscription_tier"; tierName: string }
) & { provider: PaymentsProvider; handoffs?: PaymentsHandoff[] };

export type PaymentsCheckoutResult =
  | { ok: true; data: PaymentsCheckoutResponse }
  // A request this client should never have sent (400 "Bad request",
  // "Invalid hostname", soft_pack_not_purchasable) or a 200 body we could not
  // read. Not actionable by the player; log it and show a generic failure.
  | { ok: false; code: "client_bug" }
  // 403: the tier is sold only to players who own OpenFront on Steam.
  | { ok: false; code: "steam_licence_required" }
  // 400 "Pack not available" / "Tier not available": the catalog this client
  // rendered from is stale. Refetch cosmetics.json before showing the store
  // again.
  | { ok: false; code: "listing_stale" }
  // 400 listing_not_synced: the listing exists but the rail has not ingested
  // it yet. Transient — "try again later".
  | { ok: false; code: "retry_later" }
  // 400 kind_unavailable_on_provider: this rail does not sell this kind.
  // Today that is only a subscription on the Steam rail (Phase 9 not built);
  // custom_currency is sold on both rails since OPE-337. Reaching this from
  // the store means the UI and the server disagree.
  | {
      ok: false;
      code: "kind_unavailable_on_provider";
      provider: PaymentsProvider;
      kind: PaymentsKind;
    }
  // 400 provider_account_required: the account is not linked to that rail.
  // The remedy is to re-authenticate against it.
  | {
      ok: false;
      code: "provider_account_required";
      provider: PaymentsProvider;
    }
  | { ok: false; code: "unauthorized" }
  // 409 subscription_exclusivity: a subscription already exists on the OTHER
  // rail. `message` is the server's player-facing text and names the rail, so
  // show it as-is. `existingProvider` is always non-null here — a subscription
  // GRANTED by Steam ownership does not trigger this.
  | {
      ok: false;
      code: "subscription_exclusivity";
      message: string;
      existingProvider: PaymentsProvider;
      existingTier: string;
    }
  // 409 pending_provider_transaction: an earlier order on this rail is still
  // open. The player must finish or cancel it first.
  | {
      ok: false;
      code: "pending_provider_transaction";
      provider: PaymentsProvider;
    }
  // 409 already_subscribed: the player already holds THIS tier on THIS rail
  // (a double click, or the store offered a tier they have). Nothing was
  // charged.
  | { ok: false; code: "already_subscribed"; existingTier: string }
  // 409 subscription_past_due: the player's Stripe subscription failed to
  // renew and Stripe is still retrying it, so a second one would double-bill.
  // The recovery is fixing the card in the billing portal, which admits a
  // past_due subscription even though /users/@me does not return it.
  | { ok: false; code: "subscription_past_due" }
  // 409 tier_change_unavailable_on_provider: a Steam subscriber tried to
  // change tier and Steam refused a second agreement while one is live, or
  // tier changes are switched off on that rail. `message` is the server's
  // player-facing text and says what to do (cancel in the Steam account,
  // subscribe again after it ends).
  | {
      ok: false;
      code: "tier_change_unavailable_on_provider";
      provider: PaymentsProvider;
      message: string;
    }
  // 429: one checkout per 60s per player. No order was minted.
  | { ok: false; code: "rate_limited"; retryAfterSeconds: number | null }
  // 501 provider_unavailable: the rail is switched off. Deliberately not a
  // 500 — nothing is broken, so don't report it as an error.
  | { ok: false; code: "provider_unavailable"; provider: PaymentsProvider }
  // 502 provider_error: the rail itself failed. Honour `retryable`; a retry
  // mints a FRESH order rather than resuming this one.
  | {
      ok: false;
      code: "provider_error";
      provider: PaymentsProvider;
      providerCode: string | null;
      retryable: boolean;
    }
  | { ok: false; code: "failed" };

// 400 reasons that mean this client sent something it never should have.
const CHECKOUT_CLIENT_BUG_REASONS = [
  "Bad request",
  "Invalid hostname",
  "soft_pack_not_purchasable",
];

// 400 reasons that mean the rendered catalog is stale.
const CHECKOUT_STALE_LISTING_REASONS = [
  "Pack not available",
  "Tier not available",
];

function readProvider(value: unknown): PaymentsProvider | null {
  return value === "steam" || value === "stripe" ? value : null;
}

function readRetryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) ? seconds : null;
}

// POST /payments/checkout — mints an order on the chosen rail and says how to
// hand the player over to it. Replaces both legacy Stripe endpoints for packs,
// custom currency and subscription tiers.
//
// Unlike the legacy checkout helpers it replaced, failures are NOT collapsed
// to `false`:
// callers have to tell "the rail is off" from "you already have a pending
// Steam purchase" from "try again later", and each of those is a different
// thing to say to the player.
export async function createPaymentsCheckout(
  request: PaymentsCheckoutRequest,
): Promise<PaymentsCheckoutResult> {
  try {
    const response = await fetch(`${getApiBase()}/payments/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({
        ...request,
        hostname: window.location.origin,
      }),
    });

    if (response.status === 401) {
      await logOut();
      return { ok: false, code: "unauthorized" };
    }
    if (response.status === 429) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfterSeconds: readRetryAfterSeconds(response),
      };
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const reason = typeof body?.reason === "string" ? body.reason : "";
      const provider = readProvider(body?.provider);

      if (response.status === 400) {
        if (CHECKOUT_CLIENT_BUG_REASONS.includes(reason)) {
          // Body-free, like the other refusal logs. Kept at error (rather
          // than the warn the two unrecognised-400 paths use) because the
          // reason here is one we recognise and it means this client sent
          // something it never should have -- a real bug, not a refusal we
          // simply cannot classify.
          console.error("createPaymentsCheckout: client-bug 400 response");
          return { ok: false, code: "client_bug" };
        }
        if (CHECKOUT_STALE_LISTING_REASONS.includes(reason)) {
          return { ok: false, code: "listing_stale" };
        }
        if (reason === "listing_not_synced") {
          return { ok: false, code: "retry_later" };
        }
        if (reason === "kind_unavailable_on_provider") {
          const kind = PaymentsKindSchema.safeParse(body?.kind);
          if (provider !== null && kind.success) {
            return {
              ok: false,
              code: "kind_unavailable_on_provider",
              provider,
              kind: kind.data,
            };
          }
        }
        if (reason === "provider_account_required" && provider !== null) {
          return { ok: false, code: "provider_account_required", provider };
        }
      }

      if (response.status === 409) {
        if (reason === "subscription_exclusivity") {
          const existingProvider = readProvider(body?.existingProvider);
          // The 409 body always carries a non-null existingProvider; a body
          // without one is malformed, not the "granted subscription" case
          // (which does not 409 at all).
          if (existingProvider !== null) {
            return {
              ok: false,
              code: "subscription_exclusivity",
              message: typeof body?.message === "string" ? body.message : "",
              existingProvider,
              existingTier:
                typeof body?.existingTier === "string" ? body.existingTier : "",
            };
          }
        }
        if (reason === "pending_provider_transaction" && provider !== null) {
          return { ok: false, code: "pending_provider_transaction", provider };
        }
        if (reason === "subscription_past_due") {
          return { ok: false, code: "subscription_past_due" };
        }
        if (reason === "already_subscribed") {
          return {
            ok: false,
            code: "already_subscribed",
            existingTier:
              typeof body?.existingTier === "string" ? body.existingTier : "",
          };
        }
        if (
          reason === "tier_change_unavailable_on_provider" &&
          provider !== null
        ) {
          return {
            ok: false,
            code: "tier_change_unavailable_on_provider",
            provider,
            message: typeof body?.message === "string" ? body.message : "",
          };
        }
      }

      if (response.status === 403 && reason === "steam_licence_required") {
        return { ok: false, code: "steam_licence_required" };
      }

      if (response.status === 501 && provider !== null) {
        return { ok: false, code: "provider_unavailable", provider };
      }

      if (response.status === 502 && provider !== null) {
        return {
          ok: false,
          code: "provider_error",
          provider,
          providerCode: typeof body?.code === "string" ? body.code : null,
          // Absent means "don't retry": a retry mints a new order, so the
          // safe default is not to spend one.
          retryable: body?.retryable === true,
        };
      }

      console.error(
        "createPaymentsCheckout: request failed",
        response.status,
        reason,
      );
      return { ok: false, code: "failed" };
    }

    const parsed = PaymentsCheckoutResponseSchema.safeParse(
      await response.json(),
    );
    if (!parsed.success) {
      console.error(
        "createPaymentsCheckout: Zod validation failed",
        z.prettifyError(parsed.error),
      );
      return { ok: false, code: "failed" };
    }
    return { ok: true, data: parsed.data };
  } catch (e) {
    console.error("createPaymentsCheckout: request failed", e);
    return { ok: false, code: "failed" };
  }
}

export type FinalizeSteamOrderResult =
  // The server answered with one of four resolutions; `resolution` is passed
  // through untouched. Only "settled" means the credit landed, and only
  // "expired" means it definitively will not -- see SteamOrderResolutionSchema.
  | { ok: true; resolution: SteamOrderResolution }
  // 404: the order is unknown or belongs to someone else.
  | { ok: false; code: "not_found" }
  | { ok: false; code: "unauthorized" }
  | { ok: false; code: "failed" };

// POST /payments/steam/finalize — settles a Steam overlay purchase.
//
// `orderId` is the INTERNAL purchases id from the checkout response, not any
// id Steam reports over the microtransaction bridge.
//
// SAFETY: only call this once Steam has reported the dialog was AUTHORIZED. A
// client-channel order skips the server's abandon rule and finalizes
// unconditionally, so finalizing a dialog the player cancelled charges someone
// who walked away. On a cancelled or declined dialog, do nothing and let the
// server-side sweeper resolve the order.
export async function finalizeSteamOrder(
  orderId: string,
): Promise<FinalizeSteamOrderResult> {
  try {
    const response = await fetch(`${getApiBase()}/payments/steam/finalize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({ orderId }),
    });
    if (response.status === 401) {
      await logOut();
      return { ok: false, code: "unauthorized" };
    }
    if (response.status === 404) {
      return { ok: false, code: "not_found" };
    }
    if (!response.ok) {
      console.error(
        "finalizeSteamOrder: request failed",
        response.status,
        response.statusText,
      );
      return { ok: false, code: "failed" };
    }
    const parsed = SteamFinalizeResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      // We cannot tell which of the four resolutions this was, so we must not
      // guess one. Callers treat this the same as an unreachable server.
      console.error(
        "finalizeSteamOrder: Zod validation failed",
        z.prettifyError(parsed.error),
      );
      return { ok: false, code: "failed" };
    }
    return { ok: true, resolution: parsed.data.resolution };
  } catch (e) {
    console.error("finalizeSteamOrder: request failed", e);
    return { ok: false, code: "failed" };
  }
}

export async function cancelSubscription(): Promise<boolean> {
  try {
    const response = await fetch(`${getApiBase()}/subscriptions/@me/cancel`, {
      method: "POST",
      headers: {
        Authorization: await getAuthHeader(),
      },
    });
    if (response.status === 401) {
      await logOut();
      return false;
    }
    if (!response.ok) {
      console.error(
        "cancelSubscription: request failed",
        response.status,
        response.statusText,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error("cancelSubscription: request failed", e);
    return false;
  }
}

export async function markNoticeSeen(notice: string): Promise<boolean> {
  try {
    const response = await fetch(`${getApiBase()}/users/@me/notices`, {
      method: "POST",
      headers: {
        Authorization: await getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ notice }),
    });
    if (!response.ok) {
      console.error(
        "markNoticeSeen: request failed",
        response.status,
        response.statusText,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error("markNoticeSeen: request failed", e);
    return false;
  }
}

// GET /api/game/:id on the game server (worker) — whether the game is a
// publicly listed lobby. False on any failure: callers use this to hide
// host powers that the server blocks in listed games anyway, so the safe
// default is to change nothing.
export async function fetchLobbyListed(gameID: string): Promise<boolean> {
  try {
    await ensureServerList();
    const res = await fetch(
      `${ClientEnv.gameHttpBase(gameID)}/${ClientEnv.gameWorkerPath(gameID)}/api/game/${gameID}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return false;
    const json = await res.json();
    return json?.listed === true;
  } catch (e) {
    console.warn("fetchLobbyListed: request failed", e);
    return false;
  }
}

// POST /api/game/:id/listing on the game server (worker) — toggles whether a
// private lobby appears in the public lobby browser. Creator-only and
// server-authoritative (subscription, whitelist/cheat and quota checks).
// On failure, `error` is the server's rejection code when available (e.g.
// "subscription_required", "listing_limit_reached", "listing_full").
export async function setLobbyListed(
  gameID: string,
  listed: boolean,
  options: { autoStartMs?: number; maxPlayers?: number } = {},
): Promise<{ ok: true; listed: boolean } | { ok: false; error?: string }> {
  try {
    await ensureServerList();
    const token = await getPlayToken();
    const response = await fetch(
      `${ClientEnv.gameHttpBase(gameID)}/${ClientEnv.gameWorkerPath(gameID)}/api/game/${gameID}/listing`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ listed, ...options }),
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: body?.error };
    }
    return {
      ok: true,
      listed: typeof body?.listed === "boolean" ? body.listed : listed,
    };
  } catch (e) {
    console.error("setLobbyListed: request failed", e);
    return { ok: false };
  }
}

// POST /api/game/:id/queue on the game server — the host of a listed lobby
// pays plutonium to put it in the public Special queue. The worker charges
// through the API with the host's token. On failure, `error` is the server's
// code when available ("insufficient_balance", "queue_payment_failed", ...).
export async function queueLobby(
  gameID: string,
): Promise<{ ok: true } | { ok: false; error?: string }> {
  try {
    await ensureServerList();
    const token = await getPlayToken();
    const response = await fetch(
      `${ClientEnv.gameHttpBase(gameID)}/${ClientEnv.gameWorkerPath(gameID)}/api/game/${gameID}/queue`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (response.ok) return { ok: true };
    const body = await response.json().catch(() => null);
    return { ok: false, error: body?.error };
  } catch (e) {
    console.error("queueLobby: request failed", e);
    return { ok: false };
  }
}

// POST /api/create_game on the game server — mints a fresh private lobby with
// the caller as creator. Deliberately has no worker prefix and no id: the edge
// (nginx in prod, the vite dev proxy locally) picks a worker, which mints a
// self-owned id and returns it, along with the play token the lobby was
// created under. The host must join with that same token: a cookieless guest
// (blocked third-party cookies, some iframes) is minted a new identity on each
// JWT refresh, and a refresh landing between create and join leaves the host
// in their own lobby as someone who is not its creator.
export async function createLobby(): Promise<{
  lobby: GameInfo;
  creatorToken: string;
}> {
  // A new game needs a server that takes new games on this build: ask the
  // API (multi-server v2), falling back to the page's own server. When the
  // list says nothing runs this build any more, creating against the page's
  // own (by then stale) host would at best mint a lobby on a server that is
  // going away, so stop here instead. By the time Create is clicked the
  // lobby socket has almost always raised the "update available" prompt
  // already; a Create that gets there first fails like any other failed
  // request, and the caller's own failure path (re-enabling the button,
  // clearing the share link) runs as usual.
  //
  // "outdated" is by construction a page that names no server of its own
  // (docs/MultiServer.md, OPE-430): there the list is the only thing that
  // knows where a server is, and it says there is none for this build. A
  // page a game server rendered answers "fallback" whatever the list says
  // about its own host, and creating against that host is right — it is
  // running this build, because it served this page, and it is where this
  // tab's lobby list and its session already live. That is how Create
  // behaved before the list existed, and the signal that moves such a tab
  // off a deployment on its way out is the lobby feed's commit compare and
  // drain flag, not this.
  if ((await ensureServerList()) === "outdated") {
    throw new Error(
      "createLobby: this build has no server; a newer version is available",
    );
  }
  // Send JWT token for creator identification - server extracts persistentID from it
  // persistentID should never be exposed to other clients
  const token = await getPlayToken();
  try {
    const response = await fetch(
      `${ClientEnv.serverHttpBase()}/api/create_game`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Server error response:", errorText);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log("Success:", data);

    return { lobby: data as GameInfo, creatorToken: token };
  } catch (error) {
    console.error("Error creating lobby:", error);
    throw error;
  }
}

// POST /wX/api/create_game?previous=<gameID>, targeted at the worker that owns
// the finished game — mints a successor private lobby (same creator, default
// settings) and has the old game broadcast the new id to everyone still
// connected. Returns the successor's info; the caller navigates the host there.
// Idempotent server-side: repeat calls return the same successor.
export async function createNextLobby(
  previousGameID: string,
): Promise<GameInfo> {
  // Nothing is caught here: a NoServerError from gameWorkerPath below
  // propagates to the only caller (GameRightSidebar's successor-lobby
  // button), which already catches, logs and re-enables the button — the
  // right answer for "there is no server to create it on". No "outdated"
  // check either, unlike createLobby: this continues an existing game on
  // the server that game already lives on, rather than starting something
  // new somewhere.
  await ensureServerList();
  const token = await getPlayToken();
  const response = await fetch(
    `${ClientEnv.gameHttpBase(previousGameID)}/${ClientEnv.gameWorkerPath(previousGameID)}/api/create_game?previous=${previousGameID}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("createNextLobby: server error response:", errorText);
    throw new Error(`create next lobby failed: HTTP ${response.status}`);
  }
  return (await response.json()) as GameInfo;
}

// getApiBase/getAudience moved to ApiBase.ts so ServerList.ts (which this
// module imports) can use them without a cycle; re-exported here for every
// existing importer.
export { getApiBase, getAudience };

export async function fetchGameById(
  gameId: string,
): Promise<AnalyticsRecord | false> {
  try {
    const url = `${getApiBase()}/game/${encodeURIComponent(gameId)}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (res.status !== 200) {
      console.warn(
        "fetchGameById: unexpected status",
        res.status,
        res.statusText,
      );
      return false;
    }

    const json = await res.json();
    // Lenient schema: archives written by older builds predate several
    // schema changes (see ArchivedAnalyticsRecordSchema).
    const parsed = ArchivedAnalyticsRecordSchema.safeParse(json);
    if (!parsed.success) {
      console.warn("fetchGameById: Zod validation failed", parsed.error);
      return false;
    }

    return parsed.data;
  } catch (err) {
    console.warn("fetchGameById: request failed", err);
    return false;
  }
}

// The API answers a page past the end of the ranked leaderboard with a 400
// instead of an empty list, so the end is only detectable from the error body.
// Its wording is part of the contract; the bounds vary with the page cap.
const PAGE_BOUNDS_MESSAGE = /^Page must be between \d+ and \d+$/;

export function isPageBoundsMessage(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string" &&
    PAGE_BOUNDS_MESSAGE.test(body.message)
  );
}

export async function fetchPlayerLeaderboard(
  page: number,
): Promise<RankedLeaderboardResponse | "reached_limit" | false> {
  try {
    const url = new URL(`${getApiBase()}/leaderboard/ranked`);
    url.searchParams.set("page", String(page));
    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      if (res.status === 400) {
        const body = await res.json().catch(() => null);
        if (isPageBoundsMessage(body)) {
          return "reached_limit";
        }
      }
      console.warn(
        "fetchPlayerLeaderboard: unexpected status",
        res.status,
        res.statusText,
      );
      return false;
    }

    const parsed = RankedLeaderboardResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(
        "fetchPlayerLeaderboard: Zod validation failed",
        parsed.error.toString(),
      );
      return false;
    }

    return parsed.data;
  } catch (err) {
    console.error("fetchPlayerLeaderboard: request failed", err);
    return false;
  }
}

export async function getNews(): Promise<NewsItem[]> {
  try {
    const res = await fetch(`${getApiBase()}/news.json`, {
      headers: { Accept: "application/json" },
    });
    if (res.status !== 200) {
      console.warn("getNews: unexpected status", res.status);
      return newsItemsFallback as NewsItem[];
    }
    const json = await res.json();
    const parsed = z.array(NewsItemSchema).safeParse(json);
    if (!parsed.success) {
      console.warn("getNews: Zod validation failed", parsed.error);
      return newsItemsFallback as NewsItem[];
    }
    return parsed.data;
  } catch (err) {
    console.warn("getNews: request failed, using fallback", err);
    return newsItemsFallback as NewsItem[];
  }
}

// Fetch an API-served JSON config (news.json-style: served file + bundled fallback).
// Any error, non-200, or invalid payload falls back, parsed through the same schema so
// the fallback is validated too. The timeout guards recurring callers from a fetch that never settles.
async function getServedConfig<T>(
  name: string,
  schema: z.ZodType<T>,
  fallback: unknown,
): Promise<T> {
  try {
    const res = await fetch(`${getApiBase()}/${name}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) {
      console.warn(`${name}: unexpected status`, res.status);
      return schema.parse(fallback);
    }
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn(`${name}: Zod validation failed`, parsed.error);
      return schema.parse(fallback);
    }
    return parsed.data;
  } catch (err) {
    console.warn(`${name}: request failed, using fallback`, err);
    return schema.parse(fallback);
  }
}
