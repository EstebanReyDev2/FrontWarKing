/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.bin" {
  const binContent: string;
  export default binContent;
}

declare module "*.md" {
  const mdContent: string;
  export default mdContent;
}

declare module "*.html" {
  const htmlContent: string;
  export default htmlContent;
}

declare module "*.xml" {
  const xmlContent: string;
  export default xmlContent;
}

declare module "*.txt" {
  const txtContent: string;
  export default txtContent;
}

declare module "*.txt?raw" {
  const txtRawContent: string;
  export default txtRawContent;
}

declare module "*.webp" {
  const webpContent: string;
  export default webpContent;
}
