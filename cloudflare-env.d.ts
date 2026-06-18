// Binding types for `getCloudflareContext().env`. Augments the global
// CloudflareEnv interface declared by @opennextjs/cloudflare with the
// AVAIL_RATE_LIMITER Workers rate-limiting binding (wrangler.jsonc), read by
// availabilityWithinLimit in src/lib/rate-limit.ts.
export {};

declare global {
  interface CloudflareEnv {
    AVAIL_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  }
}
