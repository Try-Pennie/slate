import { DateTime } from "luxon";
import { formatClockTime } from "@/lib/date/parse";
// Relative value import so this module still runs under `node --experimental-
// strip-types` in tests (roles.ts only type-imports "@/…", which is erased).
import { atLeast, canModerateAllOoo, roleLabel } from "../auth/roles.ts";
import type { OooRequest, OooStatus, Role, User } from "@/lib/db/types";

/**
 * Pure, side-effect-free cores of the OOO workflow (authz, transitions, the
 * when-line formatter), split out from the orchestration/service so they're
 * deterministic and unit-testable. See `scripts/test-ooo-core.ts`.
 */

type Actor = { id: string; role: Role };
type RequestLike = Pick<OooRequest, "user_id" | "manager_id" | "status">;

/**
 * Approve/reject: the request's manager of record, or anyone who can moderate
 * all OOO (team leads, admins, super admins).
 *
 * The manager of record must ALSO hold at least `manager` (#1475). The link used
 * to grant approval with no floor on the named person's own role, so an AGENT
 * could approve or decline time off, including a MANAGER's, purely by being the
 * value in someone's `manager_id`. That was live: a manager had one of his own
 * agents as his manager of record, so that agent was the approver for a manager's
 * time off (#1474 cleared the link, this closes the rule behind it).
 *
 * It was also a LOWER bar than editing the same person's hours, which needs
 * `canManageAgents` (`atLeast(role, "manager")`). Approving somebody's time off
 * should not be easier than changing their working week.
 *
 * `atLeast`, never `role === "manager"`: an equality against one rank of a five
 * tier hierarchy refuses every rank ABOVE it, so a team lead or admin named as
 * someone's manager of record would be turned away by the very check meant to
 * raise the bar (L122).
 *
 * When the named person does not qualify, nothing is stranded: `canModerateAllOoo`
 * still lets team leads and up act, which is the honest fallback rather than
 * silently treating an unqualified person as an approver.
 *
 * An admin may not decide their OWN request (#3114), by either route: another
 * admin or a team lead does. A team lead deciding their own stays allowed (Dan,
 * 2026-10-03: only admins change).
 */
export function canModerate(actor: Actor, request: RequestLike): boolean {
  if (isAdminDecidingOwn(actor, request)) return false;
  if (canModerateAllOoo(actor.role)) return true;
  return (
    request.manager_id !== null &&
    actor.id === request.manager_id &&
    canHoldManagerOfRecord(actor.role)
  );
}

/** What an admin is told when they try to decide their own request (#3114). */
export const OWN_REQUEST_REFUSAL =
  "You can't approve or decline your own time off. Another admin or a team lead can.";

/** An admin (or super admin) acting on a request they made themselves (#3114). */
export function isAdminDecidingOwn(actor: Actor, request: Pick<RequestLike, "user_id">): boolean {
  return actor.id === request.user_id && atLeast(actor.role, "admin");
}

/**
 * Whether a role can hold the manager-of-record power at all (#1475).
 *
 * The floor, named once, so the RULE in canModerate, the notification that decides
 * who to DM, and the queue badge that explains why a request is waiting all read
 * the same predicate. Three places asking the same question with three hand-rolled
 * role tests is how the button and the action end up disagreeing (#1468).
 */
export function canHoldManagerOfRecord(role: Role): boolean {
  return atLeast(role, "manager");
}

/**
 * The queue's explanation for a request whose manager of record cannot approve it.
 *
 * A builder, not a sentence inline in the page, for the reason the alert and booker
 * copy live in builders: it is the only way the words can be read and tested
 * without mounting the screen they appear on.
 */
export function managerCannotApproveNotice(managerName: string, role: Role): string {
  return (
    `${managerName} is set as their manager of record but does not hold a manager role ` +
    `(they are ${roleLabel(role) === "agent" ? "an" : "a"} ${roleLabel(role)}), so nobody was ` +
    `nudged to review it. Approve it here, and correct their Agent Manager in Salesforce.`
  );
}

/** Cancel: the requester themselves, or an admin cleaning up. */
export function canCancel(actor: Actor, request: RequestLike): boolean {
  return actor.id === request.user_id || atLeast(actor.role, "admin");
}

/**
 * Retry the calendar updates on an approved request whose side effects partly
 * failed: whoever moderates all time off, so team leads and up (#1468, #1473).
 *
 * Read from `canModerateAllOoo` rather than restating its rank, because the two
 * are one job. Dan's call, 2026-08-13: "team leads already moderate every
 * request, so they should be able to press the repair when its calendar updates
 * fail." Splitting them across two ranks meant the person who approved a request
 * was not allowed to fix it and had to go and find an admin.
 *
 * Never an equality against a single rank. This gate shipped as `role === "admin"`
 * in a five tier hierarchy, which refuses `super_admin`, the only rank above it,
 * so the person most likely to reach for the repair was the one person it turned
 * away (L122).
 *
 * It lives here rather than inline in the orchestration so the BUTTON offering
 * the repair and the ACTION performing it read the same predicate and cannot
 * drift apart: the page used to render it for team leads and up, who then met a
 * bare "Not authorized" with nothing naming the gate.
 */
export function canRetrySideEffects(actor: Pick<Actor, "role">): boolean {
  return canModerateAllOoo(actor.role);
}

/** Modify: only the requester (a manager who wants changes rejects instead). */
export function canModify(actor: Actor, request: RequestLike): boolean {
  return actor.id === request.user_id;
}

const TRANSITIONS: Record<OooStatus, OooStatus[]> = {
  pending: ["approved", "rejected", "cancelled"],
  approved: ["cancelled", "pending"], // -> pending only via modify (re-approval)
  rejected: [],
  cancelled: [],
};

export function canTransition(from: OooStatus, to: OooStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses that hold the duplicate window / can still change. */
export const ACTIVE_STATUSES: OooStatus[] = ["pending", "approved"];

export function overlaps(
  aStartIso: string,
  aEndIso: string,
  bStartIso: string,
  bEndIso: string,
): boolean {
  return (
    Date.parse(aStartIso) < Date.parse(bEndIso) &&
    Date.parse(aEndIso) > Date.parse(bStartIso)
  );
}

/** Upper bound on a single request's length. */
export const MAX_OOO_DAYS = 90;

/** Returns a user-facing error for an invalid request window, or null. */
export function validateWindow(
  startIso: string,
  endIso: string,
): string | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "Those dates could not be read. Please pick the dates again.";
  }
  if (start >= end) {
    return "The end of your time off must be after the start.";
  }
  if (end - start > MAX_OOO_DAYS * 24 * 60 * 60 * 1000) {
    return `Time off can't be longer than ${MAX_OOO_DAYS} days. Please submit it as separate requests.`;
  }
  return null;
}

// US zone label map ported from the Apps Script's normalizeTzLabel_, keyed by
// IANA id (what Slate stores) with the legacy abbreviation spellings kept so
// imported sheet rows render identically.
const TZ_LABELS: Record<string, string> = {
  "america/new_york": "ET",
  et: "ET",
  est: "ET",
  edt: "ET",
  "america/chicago": "CT",
  ct: "CT",
  cst: "CT",
  cdt: "CT",
  "america/denver": "MT",
  mt: "MT",
  mst: "MT",
  mdt: "MT",
  "america/phoenix": "MT",
  "america/los_angeles": "PT",
  pt: "PT",
  pst: "PT",
  pdt: "PT",
  "america/anchorage": "AKT",
  akt: "AKT",
  akst: "AKT",
  akdt: "AKT",
  "pacific/honolulu": "HST",
  hst: "HST",
  utc: "UTC",
  "etc/utc": "UTC",
  gmt: "UTC",
  z: "UTC",
};

export function normalizeTzLabel(tzId: string, preferred?: string): string {
  const fromPreferred = TZ_LABELS[(preferred ?? "").trim().toLowerCase()];
  if (fromPreferred) return fromPreferred;
  const fromId = TZ_LABELS[(tzId ?? "").trim().toLowerCase()];
  if (fromId) return fromId;
  return (preferred ?? "").trim() || "UTC";
}

function dayPart(dt: DateTime): string {
  return dt.toFormat("ccc, LLL d yyyy");
}

function timePart(dt: DateTime): string {
  // One spelling, from `@/lib/date/parse` (#1765). This expression existed
  // character for character in the booker too, and three more places spelled the
  // same time differently. An unreadable DateTime answers "" rather than a
  // plausible time: `formatWhenLine` has already replaced an invalid zone above,
  // and a gap in the sentence is visibly wrong where a real looking time is not.
  return formatClockTime(dt) ?? "";
}

/**
 * Human "when" line in the agent's display timezone, format-identical to the
 * Apps Script's whenLineInTz_ (ASCII hyphen only, per the copy rules):
 *   single-day:  Tue, Oct 7 2025 from 4:00pm - 6:00pm ET
 *   multi-day:   Fri, Oct 10 2025 7:00pm - Sun, Oct 12 2025 7:00pm ET
 */
export function formatWhenLine(
  startIso: string,
  endIso: string,
  tzId: string,
  tzLabel?: string,
): string {
  const zone = DateTime.fromISO(startIso, { zone: tzId }).isValid
    ? tzId
    : "Etc/UTC";
  const s = DateTime.fromISO(startIso, { zone });
  const e = DateTime.fromISO(endIso, { zone });
  const label = normalizeTzLabel(zone, tzLabel);
  if (dayPart(s) === dayPart(e)) {
    return `${dayPart(s)} from ${timePart(s)} - ${timePart(e)} ${label}`;
  }
  return `${dayPart(s)} ${timePart(s)} - ${dayPart(e)} ${timePart(e)} ${label}`;
}

/**
 * How a person is labeled across OOO notifications: their name, else their email,
 * else a caller-supplied neutral fallback. Defined once (#1002/#1014) so every
 * name display (agent or manager) resolves identically; only the fallback wording
 * differs by role, so it's a parameter rather than a copied function.
 */
export function displayName(
  person: Pick<User, "name" | "email"> | null | undefined,
  fallback: string,
): string {
  return person?.name ?? person?.email ?? fallback;
}

/** An agent's display name (fallback "An agent"). */
export function agentDisplayName(
  agent: Pick<User, "name" | "email"> | null | undefined,
): string {
  return displayName(agent, "An agent");
}

/** A manager's display name (fallback "the manager", not "An agent") (#1014). */
export function managerDisplayName(
  manager: Pick<User, "name" | "email"> | null | undefined,
): string {
  return displayName(manager, "the manager");
}

/**
 * The shared "when + reason" body describing one time-off request: the human when
 * line in the agent's zone, then the reason. Defined once (#1002) and reused by
 * both the per-request manager notification and the daily digest, so a copy change
 * (the "Reason:" label, the layout) tracks in both places. Notes and the agent
 * framing legitimately differ per message, so they stay with each caller.
 */
export function formatRequestWhenAndReason(
  r: Pick<
    OooRequest,
    "starts_at" | "ends_at" | "display_tz_id" | "display_tz_label" | "reason"
  >,
): string {
  return `${formatWhenLine(r.starts_at, r.ends_at, r.display_tz_id, r.display_tz_label)}\nReason: ${r.reason}`;
}

export const DUPLICATE_REQUEST_MESSAGE =
  "A request for this exact time range already exists. Check your pending requests or change the dates.";

/**
 * Who reviews time off for somebody with no manager of record (#1499).
 *
 * Submission used to REFUSE that person with "ask an admin to set your manager",
 * which after #1474 names a step nobody can take: the admin field is read only
 * because Salesforce owns the link, and Salesforce holds null for all nine of
 * them (every one of Pennie's debt managers among them). So the request is
 * accepted and routed to whoever moderates all time off, which is exactly who
 * would have approved it anyway.
 *
 * One constant, read by the queue, the Slack fallback post and the /me copy, so
 * the person promised a reviewer and the person who can actually act cannot
 * drift apart.
 */
export const NO_MANAGER_REVIEWER = "a team lead or admin";

/**
 * The reviewer named when a manager of record EXISTS but their row could not be
 * read (#1647).
 *
 * A third state, because the other two are already spoken for and neither is
 * true here: a name we do not have, and `NO_MANAGER_REVIEWER`, which is the
 * moderator pool somebody with no manager routes to. Falling back to that one on
 * a failed read tells a person with a manager that they have none, which is a
 * claim the read never measured (L11). This says the true part (a manager signs
 * this off) without naming one we could not read.
 */
export const UNNAMED_MANAGER_REVIEWER = "your manager";

/** A reviewer descriptor at the start of a sentence, so there is one spelling of each. */
export function capitalizeReviewer(reviewer: string): string {
  return reviewer.charAt(0).toUpperCase() + reviewer.slice(1);
}

/** `NO_MANAGER_REVIEWER` at the start of a sentence, so there is still one spelling. */
export function noManagerReviewerCapitalized(): string {
  return capitalizeReviewer(NO_MANAGER_REVIEWER);
}

/** The /me intro: who takes it from here once you submit. */
export function oooRequestIntro(managerName: string | null): string {
  return `Need a day off? Request it below and ${managerName ?? NO_MANAGER_REVIEWER} takes it from there.`;
}

/**
 * The /me form subheading: who signs these off.
 *
 * Capitalized through the shared helper rather than only in the null branch, so
 * a lower-case reviewer descriptor (`UNNAMED_MANAGER_REVIEWER`) still opens the
 * sentence properly and a real name is left exactly as it was stored.
 */
export function oooApproverLine(managerName: string | null): string {
  return `${capitalizeReviewer(managerName ?? NO_MANAGER_REVIEWER)} signs off on these.`;
}

export const DEFAULT_REJECTION_NOTE =
  "Your manager declined this request but did not provide details. If you have questions, please follow up with them directly.";

/** A short, human "Modified" stamp date (so notes don't carry raw ISO). */
export function shortDate(iso: string): string {
  const dt = DateTime.fromISO(iso);
  return dt.isValid ? dt.toFormat("LLL d, yyyy") : iso;
}

/**
 * Drop any prior "[Modified …]" markers from a notes string so edits don't
 * stack them — applied both when prefilling the edit form and before appending
 * the latest marker on save.
 */
export function stripModifiedMarkers(notes: string): string {
  return notes.replace(/\s*\[Modified[^\]]*\]/g, "").trim();
}
