import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { bucketsForAgent } from "@/lib/availability/precompute";
import {
  chooseAgentLinkPoolCode,
  isWellFormedAgentLinkToken,
  judgeAgentLink,
  newAgentLinkToken,
  type AgentLinkAgent,
  type AgentLinkBucketChoice,
  type AgentLinkJudgement,
  type AgentLinkRefusal,
} from "@/lib/agent-link/link";

/**
 * The reads and the one write behind the agent booking link (#2073). Every read
 * goes through `unwrap`, so a failed query THROWS rather than arriving as "no
 * such link", which would tell a lead with a perfectly good link that their
 * advisor is not taking bookings.
 */

/**
 * Who a token books, judged by `judgeAgentLink`. A malformed token is refused
 * before any read, so a garbage path costs nothing.
 */
export async function resolveAgentLink(token: string): Promise<AgentLinkJudgement> {
  if (!isWellFormedAgentLinkToken(token)) return { ok: false, why: "unknown" };
  const db = supabaseAdmin();
  const link = unwrap(
    await db.from("agent_links").select("user_id").eq("token", token).maybeSingle(),
    "agent link by token",
  ) as { user_id: string } | null;
  if (!link) return judgeAgentLink(null, []);

  const agent = unwrap(
    await db
      .from("users")
      .select("id, name, email, bookable, deactivated_at")
      .eq("id", link.user_id)
      .maybeSingle(),
    "agent link user",
  ) as AgentLinkAgent | null;
  // Refused before the bucket reads, which cannot change the answer for somebody
  // who has left or is not bookable. The judge orders the reasons the same way.
  if (!agent || agent.deactivated_at !== null || !agent.bookable) return judgeAgentLink(agent, []);

  return judgeAgentLink(agent, await agentBucketChoices(agent.id));
}

/** One agent's buckets, as the choices above read them. THROWS on a failed read. */
async function agentBucketChoices(userId: string): Promise<AgentLinkBucketChoice[]> {
  const codes = await bucketsForAgent(userId);
  if (codes.length === 0) return [];
  return (unwrap(
    // in-chunk-ok: one agent's buckets, bounded by the routing matrix (sixty codes).
    await supabaseAdmin().from("buckets").select("code, is_test").in("code", codes),
    "agent link buckets",
  ) ?? []) as AgentLinkBucketChoice[];
}

/**
 * The pool a REFUSED link offers instead (#2831), or null for the catch all.
 *
 * Only a link whose token still names somebody who has left or is not bookable
 * has a pool of its own to offer. Every other refusal answers null WITHOUT a
 * read: an unknown or replaced token names nobody, and an agent in no bucket has
 * no pool. So a token that never existed costs nothing here, as it costs nothing
 * in `resolveAgentLink`.
 *
 * THROWS on a failed read, like every read in this file: silently answering the
 * catch all would send a lead whose pool is known to the Low pool on a database
 * blip, which is a misroute that looks like an ordinary booking.
 */
export async function agentLinkPoolCode(token: string, why: AgentLinkRefusal): Promise<string | null> {
  if (why !== "departed" && why !== "not_bookable") return null;
  if (!isWellFormedAgentLinkToken(token)) return null;
  const link = unwrap(
    await supabaseAdmin().from("agent_links").select("user_id").eq("token", token).maybeSingle(),
    "agent link pool by token",
  ) as { user_id: string } | null;
  if (!link) return null;
  return chooseAgentLinkPoolCode(await agentBucketChoices(link.user_id));
}

/** The agent's current token, or null when they have none (a row predating 0144's backfill cannot exist, but a read is not a promise). */
export async function loadAgentLinkToken(userId: string): Promise<string | null> {
  const row = unwrap(
    await supabaseAdmin().from("agent_links").select("token").eq("user_id", userId).maybeSingle(),
    "agent link token",
  ) as { token: string } | null;
  return row?.token ?? null;
}

/**
 * Replace an agent's token, which stops the old link working at once: the old
 * token matches no row afterwards, so it reads exactly like a token that never
 * existed. An upsert keyed on the user, so pressing it twice is two replacements
 * and never two rows, and an agent somehow missing a row gets one. THROWS on a
 * refused write; the caller must not report a replacement that did not happen.
 */
export async function replaceAgentLinkToken(userId: string, actorId: string): Promise<string> {
  const token = newAgentLinkToken();
  const { error } = await supabaseAdmin()
    .from("agent_links")
    .upsert(
      { user_id: userId, token, rotated_at: new Date().toISOString(), rotated_by: actorId },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(`agent link: the new link could not be saved: ${error.message}`);
  return token;
}
