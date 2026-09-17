/**
 * What the manager is told they are about to do when they decline (#2455).
 *
 * The confirm asked "Decline Ada's request?" and stopped there. That names the
 * person and says nothing about what happens, so the one fact a manager pressing
 * it by mistake needed was missing, and the sentence read the same for a two hour
 * appointment as for a fortnight.
 *
 * The consequence is what `rejectOoo` actually does, rather than a generic
 * warning: the request is marked declined, the agent gets a Slack message about
 * it, and because a PENDING request never had a calendar event, a busy block or
 * an override behind it, nothing has to be undone and the agent simply stays
 * bookable for those days. Nothing is claimed about the note, which is optional
 * and which this control cannot see.
 *
 * Here rather than inline in the component so the wording can be read in one
 * place and pinned by `scripts/test-ooo-decline-copy.ts`, the same way the
 * agent's own two acts are (L41).
 */
export function declineConfirmCopy(
  agentName: string,
  dayCount: number,
): { question: string; consequence: string } {
  const span = dayCount > 1 ? `the ${dayCount} days` : null;
  return {
    question: span
      ? `Decline ${span} ${agentName} asked for?`
      : `Decline ${agentName}'s request?`,
    consequence: span
      ? `${agentName} is told in Slack, and stays bookable on those days.`
      : `${agentName} is told in Slack, and stays bookable then.`,
  };
}
