import { DateTime } from "luxon";
// Relative value import so this module still runs under `node --experimental-
// strip-types` in tests (roles.ts only type-imports "@/…", which is erased).
import { atLeast, canModerateAllOoo } from "../auth/roles.ts";
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
 */
export function canModerate(actor: Actor, request: RequestLike): boolean {
  if (canModerateAllOoo(actor.role)) return true;
  return request.manager_id !== null && actor.id === request.manager_id;
}

/** Cancel: the requester themselves, or an admin cleaning up. */
export function canCancel(actor: Actor, request: RequestLike): boolean {
  return actor.id === request.user_id || atLeast(actor.role, "admin");
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
  return `${dt.toFormat("h:mm")}${dt.toFormat("a").toLowerCase()}`;
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
 * The name shown for an agent across OOO notifications: their name, else their
 * email, else a neutral fallback. Defined once (#1002) so the per-request manager
 * notification and the daily digest can never drift on how an agent is labeled.
 */
export function agentDisplayName(
  agent: Pick<User, "name" | "email"> | null | undefined,
): string {
  return agent?.name ?? agent?.email ?? "An agent";
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

export const NO_MANAGER_MESSAGE =
  "You don't have a manager assigned yet. Ask an admin to set your manager before requesting time off.";

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
