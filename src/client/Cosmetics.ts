import { assetUrl } from "@openfront/shared/AssetUrls";
import {
  Cosmetics,
  CosmeticsSchema,
  findEffectForSlot,
} from "@openfront/shared/CosmeticSchemas";
import {
  PlayerCosmeticRefs,
  PlayerCosmetics,
  PlayerEffect,
  PlayerPattern,
} from "@openfront/shared/WireSchemas";
import { getApiBase, getUserMe } from "./Api";
import { UserSettings } from "./UserSettings";
import { translateText } from "./Utils";

/**
 * Ceiling on the cosmetics catalog request. Matches the bound the auth calls
 * already use (Auth.ts, Api.ts) rather than something tighter: when the
 * catalog fails to load, getPlayerCosmeticsRefs cannot expand the saved
 * `pattern:<name>` selection into pattern data, so an online player who is
 * merely slow rather than offline would join without their territory
 * pattern. A connection that has not answered in ten seconds is down; one
 * that answers in eight is not, and should keep its cosmetics.
 */
export const COSMETICS_FETCH_TIMEOUT_MS = 10_000;

let __cosmetics: Promise<Cosmetics | null> | null = null;
let __cosmeticsCache: Cosmetics | null = null;

/**
 * Synchronous accessor for the most recently resolved cosmetics. Returns null
 * before the first successful `fetchCosmetics()` call. Useful when a code path
 * cannot await (e.g. WebGL per-frame sync).
 */
export function getCachedCosmetics(): Cosmetics | null {
  return __cosmeticsCache;
}

/** Shape of an unaffordable purchase, as returned by the API. */
export interface InsufficientCurrency {
  /** Display name of the currency, e.g. "Plutonium". */
  currency: string;
  /** How much more currency is needed (raw; localized in the dialog text). */
  shortfall: number;
  /** Display name of the item being bought. */
  item: string;
  /** Whether the currency can be topped up (hard currency only). */
  canTopUp: boolean;
}

/**
 * Drops the cached cosmetics.json so the next fetchCosmetics() goes to the
 * network.
 */
export function invalidateCosmetics(): void {
  __cosmetics = null;
}

export function cosmeticsJsonUrl(): string {
  return `${getApiBase()}/cosmetics.json?rail=web`;
}

export async function fetchCosmetics(): Promise<Cosmetics | null> {
  if (__cosmetics !== null) {
    return __cosmetics;
  }
  const request = (async () => {
    try {
      const response = await fetch(cosmeticsJsonUrl(), {
        signal: AbortSignal.timeout(COSMETICS_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(`HTTP error! status: ${response.status}`);
        return null;
      }
      const result = CosmeticsSchema.safeParse(await response.json());
      if (!result.success) {
        console.error(`Invalid cosmetics: ${result.error.message}`);
        return null;
      }
      __cosmeticsCache = result.data;
      return result.data;
    } catch (error) {
      console.warn("Error getting cosmetics:", error);
      return null;
    }
  })();
  __cosmetics = request;
  void request.then((result) => {
    if (result === null && __cosmetics === request) {
      __cosmetics = null;
    }
  });
  return request;
}

/**
 * Warms the two caches every cosmetics resolution reads — the profile and the
 * catalog — so a later getPlayerCosmetics()/getPlayerCosmeticsRefs() answers
 * from memory instead of the network.
 *
 * Called from paths that are about to need cosmetics but are not ready to wait
 * for them, so the network time is spent while the player is still choosing
 * rather than after they commit. Never rejects: both calls already resolve to
 * a falsy value on failure, and callers fire and forget.
 */
export function prewarmCosmetics(): Promise<void> {
  return Promise.all([getUserMe(), fetchCosmetics()]).then(
    () => undefined,
    () => undefined,
  );
}

export async function resolveFlagUrl(
  flagRef: string,
): Promise<string | undefined> {
  if (flagRef.startsWith("flag:")) {
    const key = flagRef.slice("flag:".length);
    const cosmetics = await fetchCosmetics();
    const flagData = cosmetics?.flags?.[key];
    return flagData?.url;
  }
  if (flagRef.startsWith("country:")) {
    const code = flagRef.slice("country:".length);
    return assetUrl(`flags/${code}.svg`);
  }
  return undefined;
}

// `verified` is passed in rather than looked up: the caller has already
// resolved what name the player is joining under (see resolvePlayerName), and
// the badge has to agree with that exact decision. Reading it back out of the
// DOM here was the same missing seam.
export async function getPlayerCosmeticsRefs(
  opts: { verified?: boolean } = {},
): Promise<PlayerCosmeticRefs> {
  const userSettings = new UserSettings();
  // Resolve the profile first: getUserMe activates the per-player cosmetics
  // scope (UserSettings.setPlayerId), which must happen before selections are
  // read below.
  await getUserMe();
  const cosmetics = await fetchCosmetics();
  let pattern: PlayerPattern | null =
    userSettings.getSelectedPatternName(cosmetics);
  let patternDenied = false;

  if (pattern) {
    const userMe = await getUserMe();
    if (userMe) {
      const flareName =
        pattern.colorPalette?.name === undefined
          ? `pattern:${pattern.name}`
          : `pattern:${pattern.name}:${pattern.colorPalette.name}`;
      const flares = userMe.player.flares ?? [];
      const hasWildcard = flares.includes("pattern:*");
      if (!hasWildcard && !flares.includes(flareName)) {
        pattern = null;
        patternDenied = true;
      }
    } else {
      // Unknown profile: keep the selection in settings, but do not send it.
      pattern = null;
    }
    if (patternDenied) {
      userSettings.setSelectedPatternName(undefined);
    }
  }

  let flag = userSettings.getFlag();
  // Dropping a flag from this join and erasing the player's saved selection
  // are two different decisions, and only one of them is reversible. Erase
  // only on a definite answer — the catalog no longer lists the flag, or the
  // profile says the player is not entitled. "We could not ask" is not an
  // answer: getUserMe() returns the same `false` for "signed out" and for a
  // refused connection, a timed-out request or an expired session, so
  // treating it as "not entitled" erased saved flags over network failures.
  let flagDenied = false;
  if (flag?.startsWith("flag:")) {
    const key = flag.slice("flag:".length);
    const flagData = cosmetics?.flags?.[key];
    if (!flagData) {
      // Only clear if cosmetics loaded successfully but the key is missing
      if (cosmetics) {
        flag = null;
        flagDenied = true;
      }
    } else {
      const userMe = await getUserMe();
      if (userMe) {
        const flares = userMe.player.flares ?? [];
        const hasWildcard = flares.includes("flag:*");
        if (!hasWildcard && !flares.includes(`flag:${flagData.name}`)) {
          flag = null;
          flagDenied = true;
        }
      } else {
        // Unknown profile: keep the selection, but do not send it. An
        // entitlement we cannot verify is not one to claim — the server does
        // not strip an unowned cosmetic ref, it refuses the connection
        // (Privilege returns "forbidden", Worker.ts closes the socket with
        // CosmeticsForbidden), so sending it would trade a lost flag for an
        // unjoinable multiplayer.
        flag = null;
      }
    }
  }
  if (flagDenied) {
    userSettings.clearFlag();
  }

  let skinName = userSettings.getSelectedSkinName() ?? undefined;
  let skinDenied = false;
  if (skinName) {
    const skin = cosmetics?.skins?.[skinName];
    if (!skin) {
      skinName = undefined;
      if (cosmetics) {
        // Cosmetics loaded but the saved skin no longer exists.
        skinDenied = true;
      }
    } else {
      const userMe = await getUserMe();
      if (userMe) {
        const flares = userMe.player.flares ?? [];
        const hasWildcard = flares.includes("skin:*");
        if (!hasWildcard && !flares.includes(`skin:${skin.name}`)) {
          skinName = undefined;
          skinDenied = true;
        }
      } else {
        // Unknown profile: keep the selection, but do not send it.
        skinName = undefined;
      }
    }
    if (skinDenied) {
      userSettings.setSelectedPatternName(undefined);
    }
  }

  let crownName = userSettings.getSelectedCrownName() ?? undefined;
  let crownDenied = false;
  if (crownName) {
    const crown = cosmetics?.crowns?.[crownName];
    if (!crown) {
      crownName = undefined;
      if (cosmetics) {
        // Cosmetics loaded but the saved crown no longer exists.
        crownDenied = true;
      }
    } else {
      const userMe = await getUserMe();
      if (userMe) {
        const flares = userMe.player.flares ?? [];
        const hasWildcard = flares.includes("crown:*");
        if (!hasWildcard && !flares.includes(`crown:${crown.name}`)) {
          crownName = undefined;
          crownDenied = true;
        }
      } else {
        // Unknown profile: keep the selection, but do not send it.
        crownName = undefined;
      }
    }
    if (crownDenied) {
      userSettings.setSelectedCrownName(undefined);
    }
  }

  // Effects: a per-slot map (slot -> effect name). A slot is the effectType for
  // trails and the nukeType for nuke explosions (see effectTypeForSlot). Drop any
  // entry whose effect no longer exists, doesn't fit the slot, or the user can't
  // access. Like skins/flags/patterns above, a selection is kept in settings (and
  // omitted from join refs) when cosmetics or userMe fail to load.
  const selectedEffects = userSettings.getSelectedEffects();
  const effects: Record<string, string> = {};
  for (const [slot, name] of Object.entries(selectedEffects)) {
    const effect = findEffectForSlot(cosmetics, slot, name);
    if (!effect) {
      if (cosmetics) {
        userSettings.setSelectedEffectName(slot, undefined);
      }
      continue;
    }
    const userMe = await getUserMe();
    if (userMe) {
      const flares = userMe.player.flares ?? [];
      const hasWildcard = flares.includes("effect:*");
      if (!hasWildcard && !flares.includes(`effect:${effect.name}`)) {
        userSettings.setSelectedEffectName(slot, undefined);
        continue;
      }
    } else {
      // Unknown profile: keep the selection in settings, but do not send it.
      continue;
    }
    effects[slot] = name;
  }

  return {
    flag: flag ?? undefined,
    patternName: pattern?.name ?? undefined,
    patternColorPaletteName: pattern?.colorPalette?.name ?? undefined,
    skinName,
    crownName,
    effects: Object.keys(effects).length > 0 ? effects : undefined,
    verified: opts.verified ? true : undefined,
  };
}

export async function getPlayerCosmetics(
  opts: { verified?: boolean } = {},
): Promise<PlayerCosmetics> {
  const refs = await getPlayerCosmeticsRefs(opts);
  const cosmetics = await fetchCosmetics();

  const result: PlayerCosmetics = {};

  if (refs.flag) {
    result.flag = await resolveFlagUrl(refs.flag);
  }

  const devPattern = new UserSettings().getDevOnlyPattern();

  if (devPattern) {
    result.pattern = {
      name: devPattern.name,
      patternData: devPattern.patternData,
      colorPalette: devPattern.colorPalette,
    };
  } else if (refs.patternName && cosmetics) {
    const pattern = cosmetics.patterns[refs.patternName];

    if (pattern) {
      result.pattern = {
        name: refs.patternName,
        patternData: pattern.pattern,
        colorPalette: refs.patternColorPaletteName
          ? cosmetics.colorPalettes?.[refs.patternColorPaletteName]
          : undefined,
      };
    }
  }

  if (refs.skinName && cosmetics) {
    const skin = cosmetics.skins?.[refs.skinName];
    if (skin) {
      result.skin = { name: refs.skinName, url: skin.url };
    }
  }

  const devCrown = new UserSettings().getDevOnlyCrown();

  if (devCrown) {
    result.crown = { name: "dev_crown", url: devCrown };
  } else if (refs.crownName && cosmetics) {
    const crown = cosmetics.crowns?.[refs.crownName];
    if (crown) {
      result.crown = { name: refs.crownName, url: crown.url };
    }
  }

  if (refs.effects && cosmetics) {
    const effects: Record<string, PlayerEffect> = {};
    for (const [slot, name] of Object.entries(refs.effects)) {
      const effect = findEffectForSlot(cosmetics, slot, name);
      if (effect) {
        effects[slot] = { name: effect.name, effectType: effect.effectType };
      }
    }
    if (Object.keys(effects).length > 0) result.effects = effects;
  }

  if (refs.verified) {
    result.verified = true;
  }

  return result;
}

export function translateCosmetic(prefix: string, name: string): string {
  const translation = translateText(`${prefix}.${name}`);
  if (translation.startsWith(prefix)) {
    return name
      .split("_")
      .filter((word) => word.length > 0)
      .map((word) => word[0].toUpperCase() + word.substring(1))
      .join(" ");
  }
  return translation;
}
