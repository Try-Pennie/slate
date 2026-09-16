// The advisor only "previously pitched" alert (#2371), as pure values and decisions.
//
// Pipedream's version of this put `ALERT - Previously Pitched - Call with {lead_email}`
// on the owning advisor's calendar. Slate's carries NO lead detail of any kind: not the
// name, not the address, not the number. That is not politeness, it is what keeps the
// row and the event OUTSIDE the erasure scope (L653): an erasure that redacts the
// booking has nothing left to reach here, so nothing can be missed.
//
// A LABEL on the call itself was rejected for the same reason: Slate's booking lives on
// the advisor's calendar with the lead as a guest, and Google copies the summary and
// description to every guest, so the warning would reach the person it is about.
//
// Kept import free so the node suite can drive it directly and so the orchestration's
// step can build the body without reaching into the Google module.

/** The reassign reason the machine contact owner path records (#9). */
export const OWNER_ALERT_REASON_CODE = "owner_reassignment";

/** Minutes the alert occupies at the head of the call. */
export const OWNER_ALERT_MINUTES = 20;

/**
 * Google's colour 4 ("Flamingo"), matching the red the Pipedream event used, so an
 * advisor who already reads that colour as "check before you dial" keeps doing so.
 * A string because that is what the Calendar API takes.
 */
export const OWNER_ALERT_COLOR_ID = "4";

/** The event's summary. Deliberately says nothing about WHO. */
export const OWNER_ALERT_TITLE = "ALERT: Previously pitched lead";

/**
 * Was this reassign the machine's contact owner override?
 *
 * Both halves are required. An ADMIN can pick "Owner reassignment" from the reason
 * picker for a coverage move they are making by hand, and that advisor has no history
 * with the lead, so an alert on their calendar would be a claim nothing measured. The
 * unset initiator is the machine path, matching the notify step's own default.
 */
export function isOwnerAlertReassign(payload: {
  initiator?: string | null;
  reasonCode?: string | null;
}): boolean {
  return (payload.initiator ?? "system") === "system" &&
    payload.reasonCode === OWNER_ALERT_REASON_CODE;
}

/** The window the alert occupies: the head of the call, for OWNER_ALERT_MINUTES. */
export function ownerAlertWindow(startsAt: string): { start: string; end: string } {
  const startMs = Date.parse(startsAt);
  if (!Number.isFinite(startMs)) {
    throw new Error(`owner alert: unreadable booking start "${startsAt}"`);
  }
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + OWNER_ALERT_MINUTES * 60_000).toISOString(),
  };
}

/**
 * What the advisor reads. It says why the call is theirs and where the detail lives,
 * and it names nobody: the lead is identified only by the booking Slate holds, behind
 * a link that already requires a signed in staff session.
 */
export function ownerAlertDescription(adminUrl: string): string {
  return [
    "This lead has spoken with you before, so this call was routed to you.",
    "Only you can see this entry; it is marked free, so it does not block your calendar.",
    `Open the booking in Slate for the lead's details: ${adminUrl}`,
  ].join("\n\n");
}

/**
 * The Google event body. No attendees field exists on it at all, so there is nothing
 * for a future edit to populate by accident, and `transparency: "transparent"` is what
 * keeps it out of free/busy and out of `isBusyEvent`.
 */
export interface OwnerAlertEventBody {
  summary: string;
  description: string;
  start: string;
  end: string;
  timezone: string;
  transparency: "transparent";
  colorId: string;
}

export function ownerAlertBody(input: {
  startsAt: string;
  timezone: string;
  adminUrl: string;
}): OwnerAlertEventBody {
  const window = ownerAlertWindow(input.startsAt);
  return {
    summary: OWNER_ALERT_TITLE,
    description: ownerAlertDescription(input.adminUrl),
    start: window.start,
    end: window.end,
    timezone: input.timezone,
    transparency: "transparent",
    colorId: OWNER_ALERT_COLOR_ID,
  };
}

/** Where an advisor reads the booking this alert is about. */
export function ownerAlertAdminUrl(appBaseUrl: string, bookingId: string): string {
  return `${appBaseUrl}/admin/bookings/${bookingId}`;
}
