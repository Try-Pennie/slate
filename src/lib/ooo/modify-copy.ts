/**
 * What the manager and the agent are told when a time off request is changed
 * (#3365), one place for every sentence (L41), pinned by
 * `scripts/test-ooo-modify-copy.ts`.
 *
 * Three outcomes, decided by what the change does to what an approval already
 * holds, never by the stored status (L680):
 *
 *  - `edited`: nothing was held (the request was never approved). The manager gets
 *    the ordinary change notice; the agent already knows what they did.
 *  - `released`: something was held and the new window is NOT inside it (wider, or
 *    moved). Everything comes down until a manager agrees to the new window, which is
 *    the behaviour every change had before #3365, and both people are now told so.
 *  - `kept`: the new window lies inside what is held, so nothing new is being asked
 *    for. The narrower window stays blocked while the manager re-approves.
 *    `calendarMatched` is whether the agent's calendar event was actually moved to
 *    it; when it was not, the earlier window is still blocked and the agent must not
 *    be told the removed hours reopened.
 */
export type ModifyOutcome =
  | { kind: "edited" }
  | { kind: "released" }
  | { kind: "kept"; shortened: boolean; calendarMatched: boolean };

/** The manager notice's heading. A shortened request is named as one, because it is
 *  the case where re-approving asks for less than before. */
export function modifyManagerHeading(o: ModifyOutcome): string {
  if (o.kind === "edited") return "Changed time off request";
  if (o.kind === "kept" && o.shortened) return "Shortened time off request (needs re-approval)";
  return "Changed time off request (needs re-approval)";
}

/** The line under the heading saying what is blocked while the manager decides. */
export function modifyManagerNote(o: ModifyOutcome, approvedWhen: string): string | null {
  if (o.kind === "edited") return null;
  if (o.kind === "released") {
    return `Previously approved for ${approvedWhen}. Nothing is blocked until you approve the new window.`;
  }
  return (
    `Already approved for ${approvedWhen}. The new window stays blocked while you decide; ` +
    `declining ends the time off and opens it to bookings.`
  );
}

/** The agent's DM, or null when the change needs no message (a pending edit). */
export function modifyAgentDm(o: ModifyOutcome, newWhen: string): string | null {
  if (o.kind === "edited") return null;
  if (o.kind === "released") {
    return (
      `Your changed time off request for ${newWhen} was sent to your manager for re-approval. ` +
      `Until it is approved none of that time is blocked, so calls can still be booked then.`
    );
  }
  const what = o.shortened ? "shortened" : "changed";
  const sent = `Your ${what} time off request for ${newWhen} was sent to your manager for re-approval.`;
  if (!o.calendarMatched) {
    return (
      `${sent} Your calendar could not be updated to match yet, so the earlier window is ` +
      `still blocked for now.`
    );
  }
  return o.shortened
    ? `${sent} That time stays blocked meanwhile, and the hours you removed are open for bookings again.`
    : `${sent} It stays blocked meanwhile.`;
}

/** Appended to the decline DM when the decline released a window that was held. */
export function declinedReleasedLine(): string {
  return "Those hours are no longer blocked, so calls can be booked then again.";
}
