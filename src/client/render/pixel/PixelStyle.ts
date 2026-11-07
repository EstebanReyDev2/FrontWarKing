/**
 * `?pixel=` style flag.
 *
 * Until F3f the old renderer and the pixel renderer coexist so both can be
 * compared in the same session:
 *
 *   ?pixel=off                 old style (the F3a baseline)
 *   ?pixel=all (or no flag)    pixel style everywhere
 *   ?pixel=structures,units    pixel only for the listed families
 *
 * The flag is presentation only. It is parsed from the URL and never reaches
 * the engine, the wire format or a replay file.
 */

export const PIXEL_FEATURES = [
  "terrain",
  "structures",
  "units",
  "fx",
  "decor",
] as const;

export type PixelFeature = (typeof PIXEL_FEATURES)[number];

export type PixelMode = "off" | "all" | "list";

export interface PixelStyle {
  mode: PixelMode;
  features: ReadonlySet<PixelFeature>;
  /** False only for `?pixel=off`. */
  enabled: boolean;
  includes(feature: PixelFeature): boolean;
}

function defaultSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

function isFeature(value: string): value is PixelFeature {
  return (PIXEL_FEATURES as readonly string[]).includes(value);
}

export function parsePixelStyle(search = defaultSearch()): PixelStyle {
  const raw = new URLSearchParams(search).get("pixel");
  if (raw === null || raw.trim() === "" || raw.trim().toLowerCase() === "all") {
    const features = new Set<PixelFeature>(PIXEL_FEATURES);
    return {
      mode: "all",
      features,
      enabled: true,
      includes: () => true,
    };
  }

  const value = raw.trim().toLowerCase();
  if (
    value === "off" ||
    value === "none" ||
    value === "false" ||
    value === "0"
  ) {
    return {
      mode: "off",
      features: new Set(),
      enabled: false,
      includes: () => false,
    };
  }

  const features = new Set<PixelFeature>();
  for (const token of value.split(",")) {
    const name = token.trim();
    if (isFeature(name)) features.add(name);
  }
  return {
    mode: "list",
    features,
    enabled: features.size > 0,
    includes: (feature) => features.has(feature),
  };
}
