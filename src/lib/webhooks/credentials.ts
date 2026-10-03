import type { WebhookEndpoint } from "@/lib/db/types";

/**
 * Where an outbound webhook credential is read from (#3091).
 *
 * The Regal API key (`webhook_endpoints.auth_header`) and the HMAC signing secret
 * (`webhook_endpoints.secret`) used to live only in the database, so anyone who
 * could read that table (a leaked service key, a backup copy, a SQL editor
 * session) held the key that authenticates every booking event to Regal. Dan
 * decided on 2026-10-03 that both move into Worker secrets, readable by the
 * running Worker alone, and that changing either becomes a deploy step.
 *
 * The move is EXPAND THEN CONTRACT (docs/migrations-runbook.md, "Deployed code
 * must keep working"). This code reads the Worker secret when it is set and falls
 * back to the column when it is not, so nothing breaks in the window between the
 * deploy and the secret being put. The monitor lane pages for as long as either
 * credential still comes from the column. The contract half of #3091 nulls the
 * columns and deletes the fallback once both secrets are confirmed.
 *
 * - `worker`: the Worker secret is set and is what was used.
 * - `database`: the Worker secret is unset and the column answered. The move is
 *   unfinished.
 * - `missing`: neither holds a value. The wire builders refuse to send rather than
 *   send unauthenticated or unsigned.
 */
export type CredentialSource = "worker" | "database" | "missing";

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

function pick(worker: string, column: string | null | undefined): { value: string; source: CredentialSource } {
  const fromWorker = worker.trim();
  if (fromWorker) return { value: fromWorker, source: "worker" };
  const fromColumn = (column ?? "").trim();
  if (fromColumn) return { value: fromColumn, source: "database" };
  return { value: "", source: "missing" };
}

/**
 * The endpoint the wire builder should use, with each credential resolved, and
 * where each one came from.
 *
 * A COPY with the two fields overridden, never a rebuild from known fields (L510),
 * so a column added to the endpoint later is carried through untouched. The
 * values themselves never leave this function except inside that copy: callers
 * log and page on `sources`, which carries no secret.
 */
export function resolveWebhookCredentials(
  endpoint: WebhookEndpoint,
  env: WebhookSecretEnv,
): { endpoint: WebhookEndpoint; sources: CredentialSources } {
  const key = pick(env.regalKey, endpoint.auth_header);
  const signing = pick(env.signingSecret, endpoint.secret);
  return {
    endpoint: { ...endpoint, auth_header: key.value || null, secret: signing.value },
    sources: { key: key.source, signing: signing.source },
  };
}

/**
 * The same answer from PRESENCE alone, for the two readers that must never hold a
 * value: the monitor lane and the admin page. The caller turns each column and
 * each Worker secret into a boolean at the read, so no secret travels further.
 */
export function credentialSourcesFor(
  stored: { hasDbKey: boolean; hasDbSigning: boolean },
  worker: { regalKeySet: boolean; signingSecretSet: boolean },
): CredentialSources {
  const one = (workerSet: boolean, dbSet: boolean): CredentialSource =>
    workerSet ? "worker" : dbSet ? "database" : "missing";
  return {
    key: one(worker.regalKeySet, stored.hasDbKey),
    signing: one(worker.signingSecretSet, stored.hasDbSigning),
  };
}

/** Whether a stored column value counts as present. Shared so every reader agrees. */
export function hasStoredValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
