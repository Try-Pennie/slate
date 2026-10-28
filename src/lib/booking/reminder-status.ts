/**
 * What each reminder email has done in the last 24 hours, for the reminder emails page
 * (#4300, milestone "Editable reminder emails"). A pure count plus an injected read, so
 * every branch is driven offline (scripts/test-reminder-status.ts); the live reads are in
 * `reminder-status-store.ts`.
 *
 * Each count reads the stamp that says when THAT outcome happened (#4296's note):
 *   * sent, by `sent_at`;
 *   * failed and skipped, by `claimed_at`, which a claim and a skip both stamp;
 *   * `legacy_claimed`, the rows the earlier reminder job left with no time at all, apart
 *     and never as sent: they are counted for calls from 24 hours ago on, the only time
 *     they carry;
 *   * the last send, whenever it was.
 * A claim in flight and a released one are none of these.
 *
 * A read that fails is `unreadable`, never a row of zeros: zeros say "none sent, none
 * failed", which is the healthy looking answer a broken read must not give (L10).
 */
import { parseStampMs } from "../date/stamp.ts";
import { BUSINESS_ZONE } from "./business-hours.ts";
import type { ReminderSendStatus } from "../db/types.ts";

export const REMINDER_STATUS_WINDOW_MS = 24 * 60 * 60_000;

/** One `booking_reminder_sends` row, as the status read takes it. */
export interface StatusSendRow {
  emailId: string;
  sentForIso: string;
  status: ReminderSendStatus;
  reason: string | null;
  claimedAtIso: string | null;
  sentAtIso: string | null;
}

/** One email's last 24 hours. */
export interface ReminderEmailStatusCounts {
  sent: number;
  failed: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  legacyClaimed: number;
  /** The last send at any time, or null when it has never sent. */
  lastSentAtIso: string | null;
  /** Rows whose stamp could not be read, so they are in no count above. */
  undated: number;
}

export type ReminderStatusReading =
  | { status: "read"; atMs: number; byEmail: Record<string, ReminderEmailStatusCounts> }
  | { status: "unreadable"; error: string };

const emptyCounts = (): ReminderEmailStatusCounts => ({
  sent: 0,
  failed: 0,
  skipped: 0,
  skippedByReason: {},
  legacyClaimed: 0,
  lastSentAtIso: null,
  undated: 0,
});

/** Count `rows` per email over the 24 hours to `nowMs`. Every id asked about is answered. */
export function countReminderSends(
  emailIds: readonly string[],
  rows: readonly StatusSendRow[],
  lastSent: Readonly<Record<string, string | null>>,
  nowMs: number,
): Record<string, ReminderEmailStatusCounts> {
  const sinceMs = nowMs - REMINDER_STATUS_WINDOW_MS;
  const out: Record<string, ReminderEmailStatusCounts> = {};
  for (const id of emailIds) out[id] = { ...emptyCounts(), lastSentAtIso: lastSent[id] ?? null };
  const inWindow = (iso: string | null, c: ReminderEmailStatusCounts): boolean => {
    const ms = parseStampMs(iso);
    if (ms === null) {
      c.undated += 1;
      return false;
    }
    return ms >= sinceMs && ms <= nowMs;
  };
  for (const r of rows) {
    const c = out[r.emailId];
    if (!c) continue;
    if (r.status === "sent") {
      if (inWindow(r.sentAtIso, c)) c.sent += 1;
    } else if (r.status === "failed") {
      if (inWindow(r.claimedAtIso, c)) c.failed += 1;
    } else if (r.status === "skipped") {
      if (inWindow(r.claimedAtIso, c)) {
        c.skipped += 1;
        const reason = r.reason?.trim() || "unknown";
        c.skippedByReason[reason] = (c.skippedByReason[reason] ?? 0) + 1;
      }
    } else if (r.status === "legacy_claimed") {
      // No time of its own: the read already limits it to calls from 24 hours ago on.
      c.legacyClaimed += 1;
    }
  }
  return out;
}

export interface ReminderStatusDeps {
  nowMs: number;
  /**
   * Every row about a call starting at or after `sinceIso`. THROWS on a failed read.
   * A superset of the window: every claim, skip and send is made before its call, so
   * anything stamped in the last 24 hours is about a call from 24 hours ago on.
   */
  loadSends: (sinceIso: string) => Promise<StatusSendRow[]>;
  /** The last `sent_at` per email id, null for none. THROWS on a failed read. */
  loadLastSent: (emailIds: string[]) => Promise<Record<string, string | null>>;
}

/** The status of every email in `emailIds`, or an explicit unknown when a read failed. */
export async function readReminderEmailStatus(emailIds: readonly string[], deps: ReminderStatusDeps): Promise<ReminderStatusReading> {
  try {
    const sinceIso = new Date(deps.nowMs - REMINDER_STATUS_WINDOW_MS).toISOString();
    const [rows, lastSent] = await Promise.all([deps.loadSends(sinceIso), deps.loadLastSent([...emailIds])]);
    return { status: "read", atMs: deps.nowMs, byEmail: countReminderSends(emailIds, rows, lastSent, deps.nowMs) };
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
}

// ------------------------------------------------------------------------- copy

/** Each skip reason the lane records, as an admin reads it. */
const SKIP_WORDS: Record<string, string> = {
  late_booking: "booked after its time",
  too_close: "under 30 minutes before the call",
  before_effective: "came due before it was switched on",
  superseded: "a closer reminder had already gone",
};

export interface ReminderStatusSummary {
  /** healthy: sent with nothing failed. failing: anything failed. quiet: nothing sent. */
  tone: "healthy" | "failing" | "quiet" | "unreadable";
  lines: string[];
}

function lastSentLine(iso: string | null): string {
  const ms = parseStampMs(iso);
  if (ms === null) return "Never sent.";
  const when = new Date(ms).toLocaleString("en-US", {
    timeZone: BUSINESS_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Last sent ${when} ET.`;
}

/**
 * The lines the page shows for one email. The positive line ("41 sent in the last 24
 * hours, none failed.") is only ever built from a measured read; an unreadable one says
 * it is not a zero.
 */
export function reminderStatusSummary(counts: ReminderEmailStatusCounts | "unreadable"): ReminderStatusSummary {
  if (counts === "unreadable") {
    return {
      tone: "unreadable",
      lines: ["Could not read what this email has sent. That is not the same as none."],
    };
  }
  const lines: string[] = [];
  let tone: ReminderStatusSummary["tone"];
  if (counts.failed > 0) {
    tone = "failing";
    lines.push(`${counts.failed} failed and ${counts.sent} sent in the last 24 hours.`);
  } else if (counts.sent > 0) {
    tone = "healthy";
    lines.push(`${counts.sent} sent in the last 24 hours, none failed.`);
  } else {
    tone = "quiet";
    lines.push("None sent in the last 24 hours.");
  }
  if (counts.skipped > 0) {
    const parts = Object.entries(counts.skippedByReason)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, n]) => `${n} ${SKIP_WORDS[reason] ?? reason}`);
    lines.push(`Skipped ${counts.skipped}: ${parts.join(", ")}.`);
  }
  if (counts.legacyClaimed > 0) {
    lines.push(`${counts.legacyClaimed} sent by the earlier reminder job, with no send time kept.`);
  }
  lines.push(lastSentLine(counts.lastSentAtIso));
  return { tone, lines };
}
