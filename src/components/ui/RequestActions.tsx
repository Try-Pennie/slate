"use client";

import { useId, useState } from "react";
import { SubmitButton } from "@/components/ui/SubmitButton";
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
 * The destructive act is destructive, so it asks first with an inline confirm,
 * and the confirm REPLACES the Edit/act pair (rather than crowding in beside
 * them) and lives in its own soft rose group, so the row never reads as a run on
 * of text links.
 *
 * WHICH act it is depends on the request (#2406). A pending request is
 * withdrawn; an approved one is cancelled, which clears the agent's calendar and
 * makes them bookable for those days again. Both used to ask the same two words,
 * so the confirmation carried no information about which of the two was
 * happening. Every word comes from `@/lib/ooo/cancel-copy`, and the sentence is
 * derived from the request rather than fixed, so a week at Thanksgiving does not
 * read the same as a two hour appointment.
 */

const ghost =
  "rounded-md px-3 py-1.5 text-sm font-semibold transition-colors";

/**
 * The destructive confirm, through the ONE submit control (#1769).
 *
 * It used to carry its own `useFormStatus`, its own disabled and `aria-busy`, and
 * its own spinner: a second, weaker copy of `SubmitButton`, weaker because it
 * stopped at "it started" and never showed that a wait was still alive or had
 * stalled. Its rose treatment is a className, so nothing about the look is lost.
 */
function ConfirmButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  return (
    <SubmitButton
      className={`${ghost} bg-error/10 text-error hover:bg-error/20`}
      pendingLabel={pendingLabel}
    >
      {label}
    </SubmitButton>
  );
}

// restore-optin-ok: this renders its own form and takes its action as a prop, so it
// is not inside the wrapper yet. It arrives with #1998.
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
  const [confirming, setConfirming] = useState(false);
  const act = cancelActForStatus(status);
  const words = CANCEL_ACT_WORDS[act];
  const questionId = useId();
  const consequenceId = useId();

  if (confirming) {
    const { question, consequence } = cancelConfirmCopy(act, dayCount);
    return (
      <form
        action={cancelAction}
        className="pn-confirm-enter w-full max-w-xs shrink-0 rounded-lg border border-error/25 bg-error/5 p-3"
      >
        <input type="hidden" name="request_id" value={requestId} />
        {/*
          Named by the question itself rather than by a repeated aria-label, so a
          screen reader hears the act it is about to confirm once, and hears the
          consequence as the group's description. Without it the two buttons
          announce as "Keep it" and "Yes, cancel" with nothing saying what of.
        */}
        <div
          role="group"
          aria-labelledby={questionId}
          aria-describedby={consequenceId}
        >
          <p id={questionId} className="text-sm font-semibold text-fg">
            {question}
          </p>
          {/*
            Full strength graphite, not `text-fg-muted`. Measured with axe on the
            live page: the muted token over this rose tint is 4.45:1, just under
            AA's 4.5, and this is the sentence that states the damage, so it must
            not be the faintest thing in the group either.
          */}
          <p id={consequenceId} className="mt-1 text-sm text-fg">
            {consequence}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={`${ghost} text-fg hover:bg-pennie-sky-soft dark:hover:bg-accent/15`}
            >
              {words.dismiss}
            </button>
            <ConfirmButton
              label={words.confirmControl}
              pendingLabel={words.confirmPending}
            />
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <EditRequestButton requestId={requestId} />
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={`${ghost} text-fg-muted hover:bg-error/10 hover:text-error`}
      >
        {words.control}
      </button>
    </div>
  );
}
