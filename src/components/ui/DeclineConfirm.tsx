"use client";

import { DestructiveConfirm } from "@/components/ui/DestructiveConfirm";
import { declineConfirmCopy } from "@/lib/ooo/decline-copy";

/**
 * The manager's two step Decline (#193).
 *
 * Declining rejects an agent's real time off and tells them in Slack, so a single
 * misclick must not do it. It renders no form of its own: it lives inside the
 * existing reject form, which is the only place it can be and still carry the
 * optional note typed beside it.
 *
 * The confirm is `DestructiveConfirm` (#2455), the same one the agent's own
 * Cancel uses. This file used to hold a second copy of that markup, down to the
 * identical hand rolled destructive button, and the two were free to drift while
 * each read as reasonable on its own. The panel and the buttons are now decided
 * in one place, and so is the shape of the question: an act named with what it is
 * about, and a consequence derived from the request rather than a generic warning
 * (`@/lib/ooo/decline-copy`).
 */
export function DeclineConfirm({
  agentName,
  dayCount,
}: {
  agentName: string;
  /** How many of the agent's days the request covers, in its own zone. */
  dayCount: number;
}) {
  const { question, consequence } = declineConfirmCopy(agentName, dayCount);

  return (
    <DestructiveConfirm
      openLabel="Decline"
      question={question}
      consequence={consequence}
      dismissLabel="Keep it"
      confirmLabel="Yes, decline"
      pendingLabel="Declining"
      panelClassName="w-full"
    />
  );
}
