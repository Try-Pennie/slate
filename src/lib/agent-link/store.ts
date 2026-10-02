import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { bucketsForAgent } from "@/lib/availability/precompute";
import {
  chooseAgentLinkPoolCode,
  judgeAgentLink,
  readAgentLinkKey,
  type AgentLinkAgent,
  type AgentLinkBucketChoice,
  type AgentLinkJudgement,
  type AgentLinkRefusal,
} from "@/lib/agent-link/link";

/**
 * The reads behind the agent booking link (#2073, #3026). Every read goes through
 * `unwrap`, so a failed query THROWS rather than arriving as "no such link", which
 * would tell a lead with a perfectly good link that their advisor is not taking
 * bookings.
 *
 * A link is a readable NAME (agent_link_names, migration 0155) or, for a link
 * sent before #3026, a 64 hex TOKEN (agent_links, migration 0144). `linkUserId`
 * is the one place that reads either, so the page, the booking API and the
 * availability lookup cannot disagree about who a link books.
 */

/**
 * Who a link names, or null when it names nobody: a value that can be neither a
 * name nor a token (refused before any read), one no row holds, or a name whose
 * user was deleted (the row keeps the name with no user, so it is never reused).
 */
async function linkUserId(link: string): Promise<string | null> {
  const key = readAgentLinkKey(link);
  if (!key) return null;
  const db = supabaseAdmin();
  const row = (
    key.kind === "token"
      ? unwrap(
          await db.from("agent_links").select("user_id").eq("token", key.token).maybeSingle(),
          "agent link by token",
        )
      : unwrap(
          await db.from("agent_link_names").select("user_id").eq("name", key.name).maybeSingle(),
          "agent link by name",
        )
  ) as { user_id: string | null } | null;
  return row?.user_id ?? null;
}

/** Who a link books, judged by `judgeAgentLink`. Every unknown link is one refusal. */
export async function resolveAgentLink(link: string): Promise<AgentLinkJudgement> {
  const userId = await linkUserId(link);
  if (!userId) return judgeAgentLink(null, []);

  const agent = unwrap(
    await supabaseAdmin()
      .from("users")
      .select("id, name, email, bookable, deactivated_at")
      .eq("id", userId)
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
 * Only a link that still names somebody who has left or is not bookable has a
 * pool of its own to offer. Every other refusal answers null WITHOUT a read: an
 * unknown link names nobody, and an agent in no bucket has no pool. So a link
 * that never existed costs nothing here, as it costs nothing in
 * `resolveAgentLink`.
 *
 * THROWS on a failed read, like every read in this file: silently answering the
 * catch all would send a lead whose pool is known to the Low pool on a database
 * blip, which is a misroute that looks like an ordinary booking.
 */
export async function agentLinkPoolCode(link: string, why: AgentLinkRefusal): Promise<string | null> {
  if (why !== "departed" && why !== "not_bookable") return null;
  const userId = await linkUserId(link);
  if (!userId) return null;
  return chooseAgentLinkPoolCode(await agentBucketChoices(userId));
}

/**
 * The agent's readable link name, or null when they have none (0155 names every
 * user, but a read is not a promise). This is what the copy link shows; the old
 * token is never shown again, and still resolves for links already sent.
 */
export async function loadAgentLinkName(userId: string): Promise<string | null> {
  const row = unwrap(
    await supabaseAdmin().from("agent_link_names").select("name").eq("user_id", userId).maybeSingle(),
    "agent link name",
  ) as { name: string } | null;
  return row?.name ?? null;
}
