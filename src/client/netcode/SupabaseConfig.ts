export type SupabaseRealtimeConfig = {
  url: string;
  publishableKey: string;
};

/**
 * Reads the browser build's Supabase settings.
 *
 * Both values are public by design: the URL and the publishable/anon key are
 * shipped in every client bundle. They are still kept out of source control so
 * a checkout without a Supabase project can build the rest of the app.
 */
export function supabaseRealtimeConfig(): SupabaseRealtimeConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (url === undefined || url.length === 0) return null;
  if (publishableKey === undefined || publishableKey.length === 0) return null;
  return { url, publishableKey };
}
