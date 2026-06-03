import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Default config (in-memory caching). Add an R2 incremental cache here later if
// we start using ISR/static revalidation.
export default defineCloudflareConfig();
