// Reading the Twilio TaskRouter worker listing from production (#2097).
//
// Twilio is where managers actually tag agents, and it is what feeds cal.com: a
// Pipedream job reads each worker's `teams` tags and writes them onto cal.com
// attributes. `Redistribute` exists ONLY here, so this read is the only way Slate
// can learn that an agent should not be taking booked calls.
//
// EVERY WAY OF LEARNING NOTHING REFUSES, and each refusal has its own wording
// (L11). That is the design decision in this file, and it is the one Dan singled
// out on the issue. A read that quietly answered with an empty list would leave
// every symptom of success in place: the lane runs, the Salesforce half works, the
// heartbeat stamps, the banner reports what Salesforce changed, and not one agent is
// ever flipped, so nobody notices until a redistribute agent takes a real lead.
//
// Each message names its CAUSE and stops there. The CONSEQUENCE is added by whoever
// reports it (the Slack alert, the roster page's notice), because those two consumers
// word it for different readers and a cause carrying its own consequence gets said
// twice in the composed sentence (L605).
//
// The credential check is deliberately NOT written as `process.env.X ?? "default"`:
// an unset wrangler secret and a workflow variable that does not exist both arrive
// as the empty string, which `??` does not catch, and that exact defect took the
// production canary down for eleven minutes (#1495, guarded since by #1498).
import { twilioApiKeySecret, twilioApiKeySid, twilioWorkspaceSid } from "@/lib/env";
import { refuseUnderLoadtest } from "@/lib/loadtest-guard";

/** How many pages to walk before giving up. The roster is one page at 200. */
const MAX_PAGES = 50;
const PAGE_SIZE = 200;

/**
 * How long to wait before the one retry (#2774).
 *
 * On 2026-09-25 a single 520 from Twilio's edge paged a person while the run an
 * hour earlier had read Twilio fine and Twilio reported no incident. A 5xx or a
 * dropped connection is the kind of failure that heals in seconds, so it gets ONE
 * more attempt after this pause. Exactly one: a real outage must still refuse
 * inside the cron invocation rather than hang it (L110), and the run-level streak
 * in `runRosterSync` is what absorbs anything longer.
 */
export const TWILIO_RETRY_DELAY_MS = 2_000;

/** How long one page of the worker listing may wait (#3972). */
export const TWILIO_PAGE_TIMEOUT_MS = 10_000;

/** The pause between attempts. Injected so no test waits for real (L524). */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export type TwilioReadFailure =
  /** One or more of the three credentials is unset or empty on this deployment. */
  | "not-configured"
  /** Twilio rejected the key (401/403), so it is missing or not TaskRouter scoped. */
  | "refused"
  /** No answer, or an answer that is not a success. */
  | "unreachable"
  /** A success carrying nothing this code can read as a worker list. */
  | "unreadable"
  /** A readable listing with no workers at all, which is never a healthy roster. */
  | "no-workers";

/**
 * A refusal to produce a worker list, carrying WHICH refusal it was.
 *
 * The caller needs the distinction: an unset secret sends somebody to the deploy
 * runbook, a 401 sends them to the Twilio console, and an empty listing sends them
 * to look at the workspace. One message answering for all three would name whichever
 * cause it happened to describe and be wrong about the others.
 */
export class TwilioReadError extends Error {
  // A plain field, not a constructor parameter property: node's strip-only
  // TypeScript mode refuses those, and this file is reached by the node suite.
  failure: TwilioReadFailure;

  constructor(failure: TwilioReadFailure, message: string) {
    super(message);
    this.name = "TwilioReadError";
    this.failure = failure;
  }
}

export interface TwilioCredentials {
  sid: string;
  secret: string;
  workspace: string;
}

/** What the deployment holds. Read here so the caller has one place to look. */
export function twilioCredentials(): TwilioCredentials {
  return { sid: twilioApiKeySid(), secret: twilioApiKeySecret(), workspace: twilioWorkspaceSid() };
}

/** One worker, reduced to the only field this reads. `attributes` is a JSON string. */
export interface TwilioWorker {
  attributes?: string;
}

/**
 * Every worker in the workspace, paged.
 *
 * `fetchImpl` is injected so the refusals are driven offline by
 * `scripts/test-twilio-client.ts`: they are the half that must work when something
 * has already gone wrong, and a live Twilio cannot be asked to produce a 401 on
 * demand. `sleep` is injected for the same reason, so the retry is driven without
 * waiting.
 */
export async function fetchTwilioWorkers(
  creds: TwilioCredentials = twilioCredentials(),
  // deadline-ok: fetchPageWithOneRetry gives every page TWILIO_PAGE_TIMEOUT_MS
  fetchImpl: typeof fetch = fetch,
  sleep: Sleep = realSleep,
): Promise<TwilioWorker[]> {
  // Before the credentials are even looked at (#2335): under a load test there is no
  // reading of the real workspace that could be correct, whatever this deployment is
  // holding.
  refuseUnderLoadtest("Twilio");
  // Emptiness, not nullishness. See the header.
  if (!creds.sid || !creds.secret || !creds.workspace) {
    throw new TwilioReadError(
      "not-configured",
      "Twilio is not configured on this deployment: TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET and TWILIO_WORKSPACE_SID must all be set (see DEPLOY.md).",
    );
  }
  const authHeader = `Basic ${Buffer.from(`${creds.sid}:${creds.secret}`).toString("base64")}`;
  const all: TwilioWorker[] = [];
  let pageToken: string | null = null;
  // A page token Twilio repeats is a real thing the Pipedream job met. Unguarded it
  // is not a wrong answer but an infinite loop inside a cron invocation, which is
  // worse than a failure because it is indistinguishable from slowness (L110).
  const seen = new Set<string>();

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`https://taskrouter.twilio.com/v1/Workspaces/${creds.workspace}/Workers`);
    url.searchParams.set("PageSize", String(PAGE_SIZE));
    if (pageToken) url.searchParams.set("PageToken", pageToken);

    const res = await fetchPageWithOneRetry(url, authHeader, fetchImpl, sleep);
    if (res.status === 401 || res.status === 403) {
      throw new TwilioReadError(
        "refused",
        `Twilio refused the credentials (${res.status}). The API key has to be TaskRouter scoped.`,
      );
    }
    if (!res.ok) {
      throw new TwilioReadError("unreachable", `Twilio's worker listing returned ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as
      | { workers?: TwilioWorker[]; meta?: { next_page_token?: string | null } }
      | null;
    if (!body || !Array.isArray(body.workers)) {
      throw new TwilioReadError("unreadable", "Twilio's worker listing answered with no readable list of workers");
    }
    all.push(...body.workers);
    const next = body.meta?.next_page_token ?? null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    pageToken = next;
  }

  if (all.length === 0) {
    throw new TwilioReadError(
      "no-workers",
      "Twilio returned no workers at all, so there was nothing to judge",
    );
  }
  return all;
}

/**
 * One page request, retried ONCE when the failure is one that can heal (#2774): no
 * answer at all, or a 5xx. Never a 401 or 403, which a second request a moment
 * later cannot change, and never another 4xx. Whatever the second attempt meets is
 * what the caller judges, so a refusal names the latest fact rather than the first.
 */
async function fetchPageWithOneRetry(
  url: URL,
  authHeader: string,
  fetchImpl: typeof fetch,
  sleep: Sleep,
): Promise<Response> {
  const attempt = async (): Promise<Response | { networkError: unknown }> => {
    try {
      // #3972: a page that never answers is a network error, retried once, rather
      // than a sync lane held until the platform kills it with nothing reported.
      return await fetchImpl(url, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(TWILIO_PAGE_TIMEOUT_MS) });
    } catch (err) {
      return { networkError: err };
    }
  };
  let res = await attempt();
  if (!(res instanceof Response) || res.status >= 500) {
    await sleep(TWILIO_RETRY_DELAY_MS);
    res = await attempt();
  }
  if (!(res instanceof Response)) {
    throw new TwilioReadError("unreachable", `Twilio did not answer: ${String(res.networkError).slice(0, 200)}`);
  }
  return res;
}
