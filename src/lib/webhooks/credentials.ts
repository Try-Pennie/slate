import type { WebhookEndpoint } from "@/lib/db/types";

/**
 * Where an outbound webhook credential comes from (#3091).
 *
 * The Regal API key and the HMAC signing secret are Worker secrets
 * (`REGAL_WEBHOOK_KEY`, `WEBHOOK_SIGNING_SECRET`), readable by the running Worker
 * alone. They used to live in `webhook_endpoints.auth_header` and `.secret`, where
 * anyone who could read the table held them. The move was expand then contract:
 * the expand half read the Worker and fell back to the columns, and migration 0163
 * nulled the columns once both secrets were confirmed. This is the contract half,
 * so the columns are never read: a stray value written there later is ignored
 * rather than quietly becoming the credential again.
 *
 * - `worker`: the Worker secret is set and is what was used.
 * - `missing`: it is unset. The wire builders refuse to send rather than send
 *   unauthenticated or unsigned.
 */
export type CredentialSource = "worker" | "missing";

export interface CredentialSources {
  /** The Regal API key, sent as the Authorization header. */
  key: CredentialSource;
  /** The HMAC secret the generic format signs its body with. */
  signing: CredentialSource;
}

/** The Worker secrets, as read by `src/lib/env.ts`. Passed in so this stays pure. */
export interface WebhookSecretEnv {
  regalKey: string;
  signingSecret: string;
}

/**
 * The endpoint the wire builder should use, with each credential taken from the
 * Worker, and where each one came from.
 *
 * A COPY with the two fields overridden, never a rebuild from known fields (L510),
 * so a column added to the endpoint later is carried through untouched. Callers
 * log on `sources`, which carries no secret.
 */
export function resolveWebhookCredentials(
  endpoint: WebhookEndpoint,
  env: WebhookSecretEnv,
): { endpoint: WebhookEndpoint; sources: CredentialSources } {
  const key = env.regalKey.trim();
  const signing = env.signingSecret.trim();
  return {
    endpoint: { ...endpoint, auth_header: key || null, secret: signing || null },
    sources: { key: key ? "worker" : "missing", signing: signing ? "worker" : "missing" },
  };
}

/** The same answer from the Worker secrets' presence, for the admin page. */
export function credentialSourcesFor(worker: {
  regalKeySet: boolean;
  signingSecretSet: boolean;
}): CredentialSources {
  return {
    key: worker.regalKeySet ? "worker" : "missing",
    signing: worker.signingSecretSet ? "worker" : "missing",
  };
}
