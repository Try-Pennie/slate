import { sendThrottledAlert, resolveAlert } from "@/lib/notify/dispatch";
import { log } from "@/lib/log";

/**
 * Appointments a coverage sweep gave up on (#1242).
 *
 * When the bulk sweep cannot place one, it settles the item as `unplaceable`
 * (nobody was free and under their daily cap at that time) or, after exhausting
 * its retries, `failed`. Both are terminal, and both mean the appointment is still
 * assigned to an agent who is not going to be there, with only a person able to
 * resolve it. Until this check existed the outcome reached exactly two places: the
 * admin coverage panel on the agent's page, and a count in the drain lane's log
 * line. So "this needs a human" depended on a human already looking, which was
 * survivable while an admin was watching the panel they had just started, and not
 * survivable once approvals and offboarding enqueue sweeps with nobody present.
 *
 * The complement of this check is #1238, and the boundary matters: this one sees
 * the give-ups the sweep RECORDED. A gap the sweep never knew about (an approval
 * where no sweep was enqueued at all, or one that died mid-flight) leaves no row
 * here and needs its own read.
 */

/** alert_state row key for the throttle. Lives with the feature so the cron lane
 *  and the settings screen refer to the one constant. */
export const COVERAGE_NEEDS_HUMAN_KEY = "coverage_needs_human";

/** The two terminal outcomes that mean a person has to act. Mirrors
 *  `ACTIONABLE_ITEM_STATUSES` in the engine, which is what the admin panel lists,
 *  so the page and the panel can never disagree about what counts (L16). */
export type StrandedStatus = "unplaceable" | "failed";

/** One appointment the sweep could not move, as read from the item worklist. */
export interface StrandedAppointment {
  bookingId: string;
  /** The agent it is still assigned to: the sweep's out agent. */
  outUserId: string;
  status: StrandedStatus;
}

/** Display context for an out agent, so the page names a person not a uuid. */
export interface CoverageOutAgent {
  id: string;
  name: string | null;
  email: string | null;
}

/** One agent still holding appointments a sweep could not move. */
export interface StrandedHolder {
  userId: string;
  name: string | null;
  email: string | null;
  /** Nobody was free and under cap at the original time. */
  unplaceable: number;
  /** The move itself kept erroring until it ran out of attempts. */
  failed: number;
}

/**
 * Group the stranded items by the agent they are stuck on. Pure, so the rule for
 * what counts is pinned by tests rather than living inside a query nothing can
 * assert against.
 *
 * The two outcomes stay SEPARATE rather than collapsing into one total, because
 * they need different remediation: nobody being free may only need a different
 * time or a deliberate over-cap override, whereas a move that kept erroring is
 * usually something systemic that will happen again to the next one.
 *
 * An agent missing from the roster read is still reported, keyed by id. A stranded
 * customer must never be dropped for a bookkeeping reason, which is the failure
 * mode where the count quietly disagrees with reality.
 *
 * Ordered worst-holder-first so a truncated list in the alert names the biggest
 * gap rather than an arbitrary one.
 */
export function strandedHoldersFromItems(
  items: StrandedAppointment[],
  agents: CoverageOutAgent[],
): StrandedHolder[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const holders = new Map<string, StrandedHolder>();
  for (const it of items) {
    let h = holders.get(it.outUserId);
    if (!h) {
      const agent = byId.get(it.outUserId);
      h = {
        userId: it.outUserId,
        name: agent?.name ?? null,
        email: agent?.email ?? null,
        unplaceable: 0,
        failed: 0,
      };
      holders.set(it.outUserId, h);
    }
    if (it.status === "failed") h.failed++;
    else h.unplaceable++;
  }
  const total = (h: StrandedHolder) => h.unplaceable + h.failed;
  return [...holders.values()].sort(
    (x, y) => total(y) - total(x) || x.userId.localeCompare(y.userId),
  );
}

// Match the other monitor notices' list cap so a broad gap stays one readable
// Slack post rather than a wall of names.
const NAME_CAP = 8;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Who the agent is, preferring a name and never rendering a placeholder. */
const whoIs = (h: StrandedHolder): string => {
  const who = h.name?.trim() || h.email || h.userId;
  return h.email && h.email !== who ? `${who} (${h.email})` : who;
};

/** Human line for one holder: who, how many, and which outcome, since the
 *  remediation differs per outcome. */
function holderLine(h: StrandedHolder): string {
  const parts: string[] = [];
  if (h.unplaceable > 0) {
    parts.push(`${plural(h.unplaceable, "appointment", "appointments")} nobody was free for`);
  }
  if (h.failed > 0) {
    parts.push(`${plural(h.failed, "appointment", "appointments")} where the move kept failing`);
  }
  return `${whoIs(h)}, ${parts.join(", ")}`;
}

/**
 * The page. States the customer-facing consequence first, because that is what
 * decides whether someone acts at 7am, then names the agents and which outcome
 * they hit, then points at the ONE place that fixes it. Deliberately carries no
 * booking ids or times: the coverage panel lists them and a page is read on a
 * phone.
 *
 * Verbs agree with the subject in both directions. Counting the nouns is not
 * enough, which is only visible rendered (`pnpm preview:alerts`).
 */
export function formatCoverageNeedsHumanAlert(holders: StrandedHolder[]): string {
  const total = holders.reduce((n, h) => n + h.unplaceable + h.failed, 0);
  const one = total === 1;
  const oneAgent = holders.length === 1;
  const lines = holders.slice(0, NAME_CAP).map(holderLine);
  const more = holders.length > NAME_CAP ? `\n(and ${holders.length - NAME_CAP} more)` : "";
  return (
    `${plural(total, "appointment", "appointments")} could not be moved to another advisor and ` +
    `${one ? "is" : "are"} still with ` +
    `${oneAgent ? "an agent who will not be there" : "agents who will not be there"}. ` +
    `${one ? "That customer" : "Those customers"} will meet nobody unless someone moves ` +
    `${one ? "it" : "them"} by hand. Reassign ` +
    `${one ? "it" : "them"} from the agent's page in Admin, under Coverage.\n` +
    lines.join("\n") +
    more
  );
}

/**
 * The all-clear. Says the customers are covered again, and deliberately does NOT
 * repeat the page's remediation: the reader is being told to stand down, and
 * carrying "reassign them from the coverage panel" into a recovery notice is how
 * someone gets sent to redo work that is already done.
 */
export function formatCoverageNeedsHumanRecovery(): string {
  return (
    `Every appointment a coverage sweep could not move has since been placed or has passed. ` +
    `No customer is left holding an appointment with an agent who will not be there, so no ` +
    `action is needed.`
  );
}

/** What one tick measured. `unreadable` is NOT zero: see the check below. */
export interface CoverageNeedsHumanResult {
  status: "clear" | "stranded" | "unreadable";
  agents: number;
  appointments: number;
}

/**
 * One monitor tick: measure what the sweep gave up on, page when there is
 * anything, and clear when a real read says there is not.
 *
 * There is deliberately NO streak here, unlike `inactive_agent_bookings`. That
 * check needs one because an admin deactivating an agent and then running the
 * coverage panel a minute later is an ordinary, correct sequence that briefly
 * looks identical to a real gap. This one is different in kind: `unplaceable` and
 * `failed` are terminal states the engine assigns only after it has tried, so the
 * condition is already settled the moment it is observed and waiting would only
 * delay telling someone. An item still being worked is `pending` and is not
 * counted here at all.
 *
 * The three states are distinct, and the third is the one this class of defect
 * keeps shipping without:
 *
 *   - stranded: page (throttled by the cooldown).
 *   - a MEASURED zero: announce recovery. `resolveAlert` is a no-op unless a page
 *     was actually delivered, so a check that never alerted stays silent.
 *   - a read that FAILED: do neither. An unread worklist comes back empty, and an
 *     empty result here is indistinguishable from "nothing is stranded", so
 *     announcing recovery off it would clear a real page at the moment the system
 *     is least able to tell anyone (#1134, #1152).
 *
 * Best-effort by design: monitoring must never take down the lane it watches, so
 * both dispatches are caught.
 */
export async function runCoverageNeedsHumanCheck(deps: {
  loadStranded: () => Promise<StrandedHolder[]>;
  cooldownMs: number;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<CoverageNeedsHumanResult> {
  let holders: StrandedHolder[];
  try {
    holders = await deps.loadStranded();
  } catch (err) {
    // Fail loud in the logs, silent on the alert channels. The lane heartbeat
    // covers a database that cannot be read at all; what must not happen is this
    // check turning an unread result into an all-clear.
    log.error("coverage-needs-human", { msg: "stranded read failed" }, err);
    deps.log?.({ status: "unreadable" });
    return { status: "unreadable", agents: 0, appointments: 0 };
  }

  const appointments = holders.reduce((n, h) => n + h.unplaceable + h.failed, 0);

  if (holders.length === 0) {
    // alert-key: coverage_needs_human
    await resolveAlert(COVERAGE_NEEDS_HUMAN_KEY, formatCoverageNeedsHumanRecovery()).catch(() => {});
    deps.log?.({ status: "clear", agents: 0, appointments: 0 });
    return { status: "clear", agents: 0, appointments: 0 };
  }

  // alert-key: coverage_needs_human
  await sendThrottledAlert(
    COVERAGE_NEEDS_HUMAN_KEY,
    deps.cooldownMs,
    formatCoverageNeedsHumanAlert(holders),
  ).catch(() => {});
  deps.log?.({ status: "stranded", agents: holders.length, appointments });
  return { status: "stranded", agents: holders.length, appointments };
}
