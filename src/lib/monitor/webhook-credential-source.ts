/**
 * #3091: are the outbound webhook credentials still being read from the database?
 *
 * The Regal API key and the generic signing secret move from
 * `webhook_endpoints.auth_header` / `.secret` into Worker secrets, expand then
 * contract. While a Worker secret is unset the delivery falls back to the column,
 * which keeps Regal receiving events but leaves the key readable by anyone with
 * database access, the exposure the move exists to close. Nothing about a working
 * delivery says which one it used, so without this the expand half could become
 * permanent with nobody noticing.
 *
 * A CONDITION with an all-clear: it is true until somebody puts the secret, and
 * the person who did needs to see it end.
 *
 * Presence only. The lane turns each column into a boolean at the read and each
 * Worker secret into a boolean at the call, so no credential value reaches this
 * module, its copy, or the log.
 *
 * Fail-safe the same way as the subscriber check beside it: an unreadable endpoint
 * read reports `measured: false`, which neither pages nor clears (L11, L90).
 */

import type { AlertResolve, ThrottledNotify } from "./alert-deps";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import { credentialSourcesFor, type CredentialSources } from "../webhooks/credentials.ts";

/** One active endpoint, reduced to whether each column holds a value. */
export interface StoredCredentialPresence {
  hasDbKey: boolean;
  hasDbSigning: boolean;
}

export interface WorkerCredentialPresence {
  regalKeySet: boolean;
  signingSecretSet: boolean;
}

export interface CredentialSourceVerdict {
  measured: boolean;
  /** Which credentials at least one active endpoint still reads from its column. */
  onDatabase: ("key" | "signing")[];
  endpointCount: number;
}

export const WEBHOOK_CREDENTIALS_KEY = "webhook_credentials_in_database";

const NAMES: Record<keyof CredentialSources, { what: string; secret: string }> = {
  key: { what: "the Regal API key", secret: "REGAL_WEBHOOK_KEY" },
  signing: { what: "the webhook signing secret", secret: "WEBHOOK_SIGNING_SECRET" },
};

export function credentialSourceVerdict(
  endpoints: StoredCredentialPresence[] | null,
  worker: WorkerCredentialPresence,
): CredentialSourceVerdict {
  if (endpoints === null) return { measured: false, onDatabase: [], endpointCount: 0 };
  const onDatabase = new Set<"key" | "signing">();
  for (const stored of endpoints) {
    const sources = credentialSourcesFor(stored, worker);
    if (sources.key === "database") onDatabase.add("key");
    if (sources.signing === "database") onDatabase.add("signing");
  }
  return {
    measured: true,
    onDatabase: (["key", "signing"] as const).filter((c) => onDatabase.has(c)),
    endpointCount: endpoints.length,
  };
}

/** The page, or "" when there is nothing to say. A pure builder so `pnpm preview:alerts` renders what ships (L41). */
export function formatCredentialsInDatabaseAlert(verdict: CredentialSourceVerdict): string {
  if (!verdict.measured || verdict.onDatabase.length === 0) return "";
  const named = verdict.onDatabase.map((c) => NAMES[c]);
  const subject =
    named.length === 1
      ? `Webhook deliveries are still reading ${named[0].what} from the database`
      : `Webhook deliveries are still reading ${named[0].what} and ${named[1].what} from the database`;
  const secrets = named.map((n) => n.secret).join(" and ");
  const put = named.length === 1 ? `the Worker secret ${secrets} is` : `the Worker secrets ${secrets} are`;
  return (
    `${subject}, because ${put} not set. Deliveries still work, but anyone who can read ` +
    `webhook_endpoints can read the credential, which is what moving it into the Worker closes (#3091). ` +
    `Put ${secrets} from the current column values (DEPLOY.md, section 2b), then the column can be nulled.`
  );
}

export function formatCredentialsInDatabaseRecovery(): string {
  return "Resolved: webhook deliveries now read their credentials from Worker secrets only.";
}

/**
 * The monitor lane step. IO is injected so every branch, the unreadable one
 * included, runs offline. The all-clear hangs off a MEASURED healthy result,
 * never off "we did not alert this run" (#1134, #1152).
 */
export async function runWebhookCredentialSourceCheck(deps: {
  loadEndpoints: () => Promise<StoredCredentialPresence[] | null>;
  worker: WorkerCredentialPresence;
  notify: ThrottledNotify;
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
  log?: (msg: string) => void;
}): Promise<CredentialSourceVerdict> {
  const endpoints = await deps.loadEndpoints().catch(() => null);
  const verdict = credentialSourceVerdict(endpoints, deps.worker);
  if (!verdict.measured) {
    deps.log?.("monitor webhook-credentials: endpoints unreadable, no verdict this tick");
    return verdict;
  }
  if (verdict.onDatabase.length > 0) {
    await deps
      .notify(WEBHOOK_CREDENTIALS_KEY, deps.cooldownMs, formatCredentialsInDatabaseAlert(verdict))
      .catch(logAlertSendFailure(WEBHOOK_CREDENTIALS_KEY));
  } else {
    await deps.resolve(WEBHOOK_CREDENTIALS_KEY, formatCredentialsInDatabaseRecovery()).catch(logResolveFailure(WEBHOOK_CREDENTIALS_KEY));
  }
  deps.log?.(
    `monitor webhook-credentials: ${verdict.onDatabase.join(", ") || "none"} on the database, ` +
      `${verdict.endpointCount} active endpoint(s)`,
  );
  return verdict;
}
