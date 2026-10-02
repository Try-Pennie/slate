/**
 * The agent booking link (#2073): a link an agent sends for the later calls with a
 * lead who is already theirs. Every other public path into the booker routes
 * through a pool; this one names ONE agent and never routes.
 *
 * Pure, with no imports, so the node suite drives every decision here
 * (`scripts/test-agent-link.ts`). The reads that feed it are in `store.ts`.
 */

/**
 * The #2073 token: 64 lowercase hex characters, 256 bits, minted by the database
 * (sha256 as hex, migration 0144) and held to this shape by a CHECK. Links sent
 * before #3026 carry one, and they keep working.
 */
export const AGENT_LINK_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The #3026 readable name: the email username, minted ONCE by the database when
 * the user is created (migration 0155) and never given to anybody else. Lowercase
 * letters, digits, dot, underscore and hyphen, beginning and ending with a letter
 * or digit, so a name can never be "." or ".." in a URL path. The migration's
 * CHECK is this pattern and this cap, and refuses any name shaped like a token, so
 * a value in the address is always exactly one of the two
 * (`scripts/test-agent-link.ts` holds the two sides together).
 */
export const AGENT_LINK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
export const AGENT_LINK_NAME_MAX_CHARS = 72;

/** What a value from the address is, judged before any read. */
export type AgentLinkKey = { kind: "token"; token: string } | { kind: "name"; name: string };

/**
 * The ONE place that decides whether a value from the URL is an old token, a
 * name, or nothing worth a read. A token shaped value is always a token, which is
 * safe because no name can have that shape.
 */
export function readAgentLinkKey(value: string): AgentLinkKey | null {
  if (AGENT_LINK_TOKEN_PATTERN.test(value)) return { kind: "token", token: value };
  if (value.length <= AGENT_LINK_NAME_MAX_CHARS && AGENT_LINK_NAME_PATTERN.test(value)) {
    return { kind: "name", name: value };
  }
  return null;
}

/** The path a lead opens. Kept in one place so the page and every link agree. */
export function agentLinkPath(link: string): string {
  return `/book/advisor/${link}`;
}

/** The address an agent copies and sends: their name, since #3026. */
export function agentLinkUrl(baseUrl: string, link: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${agentLinkPath(link)}`;
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

/**
 * The pool a refused link offers its lead instead (#2831): the advisor's lowest
 * REAL bucket, the same one `chooseAgentLinkBucket` files their link bookings
 * under, or null for the catch all. Unlike that choice it never falls back to a
 * test bucket, because this one is an ordinary routed booking for a real lead,
 * and a test pool is not a place to send one.
 */
export function chooseAgentLinkPoolCode(buckets: readonly AgentLinkBucketChoice[]): string | null {
  const real = buckets.filter((b) => !b.is_test);
  return real.length > 0 ? chooseAgentLinkBucket(real)!.code : null;
}

/** The keys a pool booking must NOT inherit from the advisor link it came from. */
const NOT_CARRIED_TO_POOL = new Set([
  // The pool is decided by `chooseAgentLinkPoolCode`, or left to the catch all,
  // never by a code that happened to ride on the advisor link.
  "xbc",
]);

/**
 * Where the button on a refused advisor link goes (#2831): the ordinary routed
 * booker, `/book`, for the advisor's own pool when there is one and with no code
 * (the catch all, #1908) when there is not.
 *
 * The rest of the link's query travels with the lead: their name, email and lead
 * id so the booker is prefilled, and the embed's own settings so it still draws
 * inside the host's frame. One exception: the `agent-direct` source that marks an
 * advisor's direct link is dropped, since a booking made from here is an ordinary
 * routed one. A source the link named for itself still travels. Every value is
 * encoded by URLSearchParams, so nothing on the link can splice a code in.
 */
export function agentLinkPoolHref(
  poolCode: string | null,
  searchParams: Readonly<Record<string, string | string[] | undefined>>,
): string {
  const q = new URLSearchParams();
  if (poolCode) q.set("xbc", poolCode);
  for (const [key, raw] of Object.entries(searchParams)) {
    if (NOT_CARRIED_TO_POOL.has(key)) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined) continue;
    if (key === "source" && value === "agent-direct") continue;
    q.set(key, value);
  }
  const query = q.toString();
  return query ? `/book?${query}` : "/book";
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
 * as the same sentence, so a page cannot be used to learn whether a link ever
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
