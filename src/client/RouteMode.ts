export function isPreviewRoute(search = window.location.search): boolean {
  return new URLSearchParams(search).has("lobby-preview");
}

export function isRealtimeDevRoute(search = window.location.search): boolean {
  return new URLSearchParams(search).has("realtime-dev");
}

export function isPixelDevRoute(search = window.location.search): boolean {
  return new URLSearchParams(search).has("pixel-dev");
}

export function shouldStartLegacyLobbyFeed(
  search = window.location.search,
): boolean {
  return (
    !isPreviewRoute(search) &&
    !isRealtimeDevRoute(search) &&
    !isPixelDevRoute(search)
  );
}

export function shouldLoadInitialAuth(
  search = window.location.search,
): boolean {
  return !isPreviewRoute(search) && !isPixelDevRoute(search);
}

export function shouldLoadTurnstile(search = window.location.search): boolean {
  return (
    !isPreviewRoute(search) &&
    !isRealtimeDevRoute(search) &&
    !isPixelDevRoute(search)
  );
}
