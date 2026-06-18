// Binding types for `getCloudflareContext().env`. Augments the global
// CloudflareEnv interface declared by @opennextjs/cloudflare so the SLOT_CACHE
// KV binding (wrangler.jsonc) is typed where the slot cache reads it.
export {};

declare global {
  interface CloudflareEnv {
    SLOT_CACHE: KVNamespace;
  }
}
