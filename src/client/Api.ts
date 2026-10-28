import {
  IdentityTokenAudiencesResponseSchema,
  IdentityTokenResponse,
  IdentityTokenResponseSchema,
  PlayerGameModeFilter,
  PlayerGameTypeFilter,
  PlayerProfile,
  PlayerProfileSchema,
  PublicPlayerGamesResponse,
  PublicPlayerGamesResponseSchema,
  PutUsernameResponse,
  PutUsernameResponseSchema,
  UserMeResponse,
  UserMeResponseSchema,
  VisibilityResponseSchema,
} from "@openfront/shared/ApiSchemas";
import {
  AnalyticsRecord,
  ArchivedAnalyticsRecordSchema,
  GameInfo,
} from "@openfront/shared/WireSchemas";
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

// Fetch an API-served JSON config with a bundled fallback. Any error, non-200,
// or invalid payload falls back, parsed through the same schema so the fallback
// is validated too. The timeout guards recurring callers from a fetch that never settles.
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
