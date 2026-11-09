/**
 * `?pixel=` flag plumbing for the app shell.
 *
 * This module is deliberately outside `render/`: the homepage imports it
 * statically to carry the flag into the in-game URL, and the layer-boundary
 * test forbids the homepage from pulling renderer code into its first
 * download. The renderer reads the same boot value through
 * `render/pixel/PixelStyle`.
 */

function defaultSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/**
 * The search string this page was loaded with.
 *
 * Starting a game rewrites the address bar several times (the share link, the
 * `#refresh` trampoline, the in-game `?live` entry) before the renderer is
 * built, so reading `window.location.search` at that point would always come
 * back empty and silently fall back to the pixel style. The flag is a
 * presentation choice made when the page loaded, so it is captured once and
 * kept for the whole session.
 */
export const bootSearch = defaultSearch();

/**
 * Carry the `?pixel=` flag into an in-app route.
 *
 * Starting a game uses history.pushState to `/<game>?live`, which drops the
 * search string the page was loaded with. The renderer picks its style when it
 * is constructed (after that navigation), so without this suffix `?pixel=off`
 * would silently fall back to the pixel style. Returns "" when the flag is
 * absent, so the game URL stays `?live`.
 *
 * Reads the boot search by default for the same reason the renderer does: by
 * the time this runs the address bar may already have been rewritten.
 */
export function pixelQuerySuffix(search = bootSearch): string {
  const raw = new URLSearchParams(search).get("pixel");
  if (raw === null || raw.trim() === "") return "";
  return `&pixel=${encodeURIComponent(raw)}`;
}
