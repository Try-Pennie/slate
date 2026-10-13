import { supabaseAdmin } from "@/lib/supabase/admin";
import { selectAllPages } from "@/lib/supabase/paginate";
import { dmSlackUserByEmail, slackConfigured } from "@/lib/notify/slack";
import { mayWriteAlerts } from "@/lib/notify/dispatch";
import { isLoadtest } from "@/lib/loadtest-guard";
import { log } from "@/lib/log";
import {
  OOO_MISMATCH_NOTICE_PREFIX,
  agentNoticeKey,
  agentOutcomeKey,
  parseNoticeRow,
  type NoticeRecord,
} from "@/lib/ooo/mismatch-escalation";
import { agentMismatchDm } from "@/lib/ooo/mismatch-notice-copy";
import type { OooEventMismatch } from "@/lib/ooo/alert-copy";

/**
 * The record of who has been told about a time off whose calendar no longer matches
 * it (#3372), and the Slack messages that tell them. Both are seams, so the monitor
 * lane and the calendar sync can be driven in tests without a database or Slack.
 */
export interface MismatchNoticeStore {
  /** Every record. Throws on a failed read: an empty list would read as nobody told. */
  list(): Promise<NoticeRecord[]>;
  /**
   * Write the record, unless it is already there. True when THIS call wrote it, so of
   * two runs telling the same person at once exactly one sends (the primary key
   * decides, never this process). Throws on any other failure, because a message
   * sent with no record of it would be sent again every tick.
   */
  claim(key: string, atMs: number): Promise<boolean>;
  /**
   * Remove the record. True when THIS call removed it, which is what lets exactly one
   * run send the all-clear. Throws on a failed delete.
   */
  release(key: string): Promise<boolean>;
}

export interface MismatchMessenger {
  /**
   * Whether a message may be sent from here at all. Off the Workers runtime (a dev
   * server pointed at the live database, #1537), under a load run, or with Slack
   * unconfigured, nothing is sent AND nothing is recorded, so a laptop can neither
   * message a real agent nor use up the record that the real lane needs.
   */
  available(): boolean;
  /** A Slack DM by email; false when it could not be delivered. Never throws. */
  dm(email: string, text: string): Promise<boolean>;
}

/** The records in `alert_state`, which is already a generic key to timestamp table. */
export function alertStateNoticeStore(): MismatchNoticeStore {
  return {
    async list() {
      // `_` is a LIKE wildcard, so it is escaped; the prefix check below is the real filter.
      const pattern = `${OOO_MISMATCH_NOTICE_PREFIX.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      // Paged: bounded by the approved time off still ahead, which is not one page by
      // construction, and a truncated read would let a request's records be missed.
      const rows = await selectAllPages<{ key: string; last_sent_at: string }>(
        "time off mismatch notices",
        "key",
        () => supabaseAdmin().from("alert_state").select("key, last_sent_at").like("key", pattern),
      );
      const out: NoticeRecord[] = [];
      for (const row of rows) {
        const rec = parseNoticeRow(row);
        if (rec) out.push(rec);
        else log.warn("ooo-mismatch-notices", { msg: "unreadable notice record skipped", key: row.key });
      }
      return out;
    },
    async claim(key, atMs) {
      const { error } = await supabaseAdmin()
        .from("alert_state")
        .insert({ key, last_sent_at: new Date(atMs).toISOString() });
      if (!error) return true;
      // 23505 is the primary key refusing: somebody wrote this record first.
      if ((error as { code?: string }).code === "23505") return false;
      throw new Error(`time off mismatch notice could not be recorded: ${error.message}`);
    },
    async release(key) {
      const { data, error } = await supabaseAdmin().from("alert_state").delete().eq("key", key).select("key");
      if (error) throw new Error(`time off mismatch notice could not be cleared: ${error.message}`);
      return (data ?? []).length > 0;
    },
  };
}

/** Slack, through the same DM the approval message uses (`dmSlackUserByEmail`). */
export function slackMismatchMessenger(): MismatchMessenger {
  return {
    available: () => mayWriteAlerts("ooo_mismatch_told", "time off mismatch DM") && slackConfigured() && !isLoadtest(),
    dm: async (email, text) => (await dmSlackUserByEmail(email, text)) !== null,
  };
}

/** One request to tell an agent about. */
export interface AgentNoticeItem {
  agentId: string;
  requestId: string;
  finding: OooEventMismatch;
}

/**
 * Tell an agent about the requests they have not yet been told about, in one
 * message. The attempt is claimed first, so the monitor lane and the calendar sync can
 * never both send about one request (the record is the claim), and once the message
 * is delivered that is recorded as its own row (`agentOutcomeKey`). An attempt with no
 * outcome is a run that died mid send, which the lane retries (`STALE_SEND_MS`).
 *
 *  - `told`: the requests this call told them about, with the delivery recorded.
 *  - `unreachable`: claimed, but the agent has no address or the DM failed, so they
 *    were NOT told. The caller decides what that means: the lane goes straight to the
 *    manager, the sync releases the claim and leaves it to the lane.
 *  - anything already recorded is left alone.
 */
export async function tellAgentAboutMismatches(deps: {
  store: MismatchNoticeStore;
  messenger: MismatchMessenger;
  nowMs: number;
  appBaseUrl: string;
  agentEmail: string | null;
  items: AgentNoticeItem[];
}): Promise<{ told: AgentNoticeItem[]; unreachable: AgentNoticeItem[] }> {
  const won: AgentNoticeItem[] = [];
  for (const item of deps.items) {
    if (await deps.store.claim(agentNoticeKey(item.agentId, item.requestId), deps.nowMs)) won.push(item);
  }
  if (won.length === 0) return { told: [], unreachable: [] };
  const delivered = deps.agentEmail
    ? await deps.messenger.dm(deps.agentEmail, agentMismatchDm(won.map((w) => w.finding), deps.appBaseUrl))
    : false;
  if (!delivered) {
    log.warn("ooo-mismatch-notices", {
      msg: "the agent could not be told about a time off mismatch",
      agent_id: won[0]!.agentId,
      requests: won.length,
      has_email: deps.agentEmail !== null,
    });
    return { told: [], unreachable: won };
  }
  for (const item of won) {
    await deps.store.claim(agentOutcomeKey(item.agentId, item.requestId, "told"), deps.nowMs);
  }
  return { told: won, unreachable: [] };
}
