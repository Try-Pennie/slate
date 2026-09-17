"use client";

import { DestructiveConfirm } from "@/components/ui/DestructiveConfirm";
import { EditRequestButton } from "@/components/ui/EditRequestButton";
import {
  CANCEL_ACT_WORDS,
  cancelActForStatus,
  cancelConfirmCopy,
} from "@/lib/ooo/cancel-copy";
import type { OooStatus } from "@/lib/db/types";

/**
 * Edit plus the destructive control for a request row.
 *
 * The destructive act is destructive, so it asks first, and the confirm REPLACES
 * the Edit/act pair (rather than crowding in beside them), so the row never reads
 * as a run on of text links.
 *
 * WHICH act it is depends on the request (#2406). A pending request is
 * withdrawn; an approved one is cancelled, which clears the agent's calendar and
 * makes them bookable for those days again. Both used to ask the same two words,
 * so the confirmation carried no information about which of the two was
 * happening. Every word comes from `@/lib/ooo/cancel-copy`, and the sentence is
 * derived from the request rather than fixed, so a week at Thanksgiving does not
 * read the same as a two hour appointment.
 *
 * The confirm itself, its panel and its buttons are `DestructiveConfirm` (#2455).
 * This file used to hold its own copy of all three, and so did the manager's
 * Decline; the two shared a hand rolled button whose rose label sat on a rose
 * wash at 3.88:1 here and 4.17:1 there, which is the same defect measuring two
 * different ways because nothing about it was measurable.
 */

// restore-optin-ok: the form this posts through is DestructiveConfirm's, which is
// not inside the wrapper yet, and the action arrives here as a prop. It moves with
// #1998.
export function RequestActions({
  requestId,
  status,
  dayCount,
  cancelAction,
}: {
  requestId: string;
  /** What the request is TODAY, which decides which act this control performs. */
  status: OooStatus;
  /** How many of the agent's days the window covers, in the request's own zone. */
  dayCount: number;
  cancelAction: (form: FormData) => void;
}) {
  const act = cancelActForStatus(status);
  const words = CANCEL_ACT_WORDS[act];
  const { question, consequence } = cancelConfirmCopy(act, dayCount);

  return (
    <DestructiveConfirm
      openLabel={words.control}
      beside={<EditRequestButton requestId={requestId} />}
      question={question}
      consequence={consequence}
      dismissLabel={words.dismiss}
      confirmLabel={words.confirmControl}
      pendingLabel={words.confirmPending}
      action={cancelAction}
      hidden={<input type="hidden" name="request_id" value={requestId} />}
      panelClassName="w-full max-w-xs shrink-0"
    />
  );
}
