/**
 * The agent booking link (#2073): a link an agent sends for the later calls with a
 * lead who is already theirs. Every other public path into the booker routes
 * through a pool; this one names ONE agent and never routes.
 *
 * Pure, with no imports, so the node suite drives every decision here
 * (`scripts/test-agent-link.ts`). The reads that feed it are in `store.ts`.
 */

/**
 * 64 lowercase hex characters, 256 bits. The same shape the database mints the
 * first token in (sha256 as hex, migration 0144) and holds every token to with a
 * CHECK, so the app's mint and the database's cannot drift into two formats.
 */
export const AGENT_LINK_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const TOKEN_BYTES = 32;

/**
 * A fresh token. Keyed on randomness and never on the agent's email: an email is
 * guessable and a link keyed on it would leak the roster, and a random token can
 * be replaced when it leaks (the admin's replace control).
 *
 * The source is injectable so the byte to hex step is testable; it must hand back
 * at least 32 bytes, and a short buffer is refused rather than padded, because a
 * padded token is a guessable one that still passes the pattern.
 */
export function newAgentLinkToken(
  randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  const bytes = randomBytes(TOKEN_BYTES);
  if (bytes.length < TOKEN_BYTES) {
    throw new Error(`agent link token: the random source returned ${bytes.length} bytes, need ${TOKEN_BYTES}`);
  }
  let out = "";
  for (let i = 0; i < TOKEN_BYTES; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** Whether a value from a URL could be a token at all, judged before any read. */
export function isWellFormedAgentLinkToken(value: string): boolean {
  return AGENT_LINK_TOKEN_PATTERN.test(value);
}

/** The path a lead opens. Kept in one place so the page and every link agree. */
export function agentLinkPath(token: string): string {
  return `/book/advisor/${token}`;
}

/** The address an agent copies and sends. */
export function agentLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${agentLinkPath(token)}`;
}

/** The bucket fields the choice below reads. */
export interface AgentLinkBucketChoice {
  code: string;
  is_test: boolean;
}

/**
 * Which of the agent's buckets a named booking is stored in.
 *
 * It has to be SOME bucket: `bookings.bucket_id` is NOT NULL, the event type
 * (length, buffers, notice, daily cap) is the bucket's, and the webhook names it.
 * It is not a routing decision, which is why the booking also records its kind
 * and every reader that reasons about routed bookings leaves it out.
 *
 * The lowest real code, so the answer is the same on every request whatever
 * order the rows arrive in. A test bucket only when the agent is in nothing
 * else, which is what lets the smoke agent's link be tried without a real lead.
 */
export function chooseAgentLinkBucket<B extends AgentLinkBucketChoice>(buckets: readonly B[]): B | null {
  const byCode = (a: B, b: B) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const real = buckets.filter((b) => !b.is_test).sort(byCode);
  if (real.length > 0) return real[0];
  const test = [...buckets].sort(byCode);
  return test[0] ?? null;
}

/** The user fields the judge below reads. */
export interface AgentLinkAgent {
  id: string;
  name: string | null;
  email: string;
  bookable: boolean;
  deactivated_at: string | null;
}

/**
 * Why a link books nobody. For the LOG only: every one of these reaches the lead
 * as the same sentence, so a page cannot be used to learn whether a token ever
 * existed or whether somebody is still on the roster.
 */
export type AgentLinkRefusal = "unknown" | "departed" | "not_bookable" | "no_bucket";

export type AgentLinkJudgement<B extends AgentLinkBucketChoice = AgentLinkBucketChoice> =
  | { ok: true; agent: AgentLinkAgent; bucketCode: string; bucket: B }
  | { ok: false; why: AgentLinkRefusal };

/**
 * Who a link may book. There is no pool behind a named link, so there is no
 * fallback: an agent who has left, or is not bookable, is simply not taking
 * bookings through it. On leave needs nothing here, because the availability
 * gates already offer no times for an absence.
 */
export function judgeAgentLink<B extends AgentLinkBucketChoice>(
  agent: AgentLinkAgent | null,
  buckets: readonly B[],
): AgentLinkJudgement<B> {
  if (!agent) return { ok: false, why: "unknown" };
  if (agent.deactivated_at !== null) return { ok: false, why: "departed" };
  if (!agent.bookable) return { ok: false, why: "not_bookable" };
  const bucket = chooseAgentLinkBucket(buckets);
  if (!bucket) return { ok: false, why: "no_bucket" };
  return { ok: true, agent, bucketCode: bucket.code, bucket };
}
