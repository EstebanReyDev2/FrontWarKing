export function isPreviewRoute(search = window.location.search): boolean {
  return new URLSearchParams(search).has("lobby-preview");
}

export function isRealtimeDevRoute(search = window.location.search): boolean {
  return new URLSearchParams(search).has("realtime-dev");
}
