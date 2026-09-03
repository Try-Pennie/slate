"use client";

import { useEffect, useRef, useState } from "react";

import { btnSecondaryCls } from "@/components/ui/styles";
import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * The two controls that take an agent out of the booking pool, each with a
 * confirm when that agent still holds upcoming appointments (#1215).
 *
 * Taking an agent out of the pool and moving that agent's upcoming bookings were
 * two completely independent actions. Either exit (deactivating, or clearing the
 * bookable flag) pulls the agent from availability and from every picker, and the
 * pool-exit cleanup prunes their cached busy time either way, but their
 * already-booked future appointments stay assigned to them. A customer could
 * arrive to meet an advisor who was gone, and the only thing preventing it was an
 * admin remembering the coverage panel further down the same page.
 *
 * One component for both controls on purpose: they ask the identical question and
 * a second copy would drift. Each speaks in the language of the control that was
 * pressed, because a toggle that warns about "deactivating" reads as the wrong
 * dialog.
 *
 * This is a CONFIRM, not a block (L54: a guard may refuse only what the system
 * genuinely cannot do). An agent really can leave mid-notice with the
 * appointments placed afterwards, and the coverage panel works on an agent who has
 * already left the pool, so refusing would only ever stop the admin who meant it.
 * The monitor lane is the backstop for the paths with no human present at all (the
 * Salesforce roster sync and the lifecycle API).
 *
 * `upcomingBookings` is null when the count could not be read. That is NOT zero:
 * waving the admin through on a failed read would claim "nothing is booked" having
 * measured nothing, so an unreadable count gets the confirm too, with copy that
 * says which of the two happened.
 */
export type PoolExitAction = "deactivate" | "not_bookable";

const COPY: Record<
  PoolExitAction,
  { label: string; confirm: string; effect: string; pending: string }
> = {
  deactivate: {
    label: "Deactivate account",
    confirm: "Deactivate anyway",
    // Names the action rather than saying "Saving", so a press never reads as
    // nothing having happened while the work runs (#1769).
    pending: "Deactivating account",
    effect:
      "Deactivating removes them from the booking pool, but it does not move those appointments",
  },
  not_bookable: {
    label: "Make not bookable",
    confirm: "Make not bookable anyway",
    pending: "Taking out of the pool",
    effect:
      "Making them not bookable takes them out of the booking pool, but it does not move those appointments",
  },
};

export default function PoolExitConfirmButton({
  action,
  agentId,
  agentName,
  upcomingBookings,
}: {
  action: PoolExitAction;
  agentId: string;
  agentName: string;
  /** Active future appointments still assigned to this agent, or null when the
   *  count could not be read. */
  upcomingBookings: number | null;
}) {
  const copy = COPY[action];
  const [confirming, setConfirming] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // The two buttons swap places in the DOM, so without moving focus deliberately
  // it lands on the document body and a keyboard or screen-reader user is dropped
  // out of the flow they just started (and cannot tab forward to the warning).
  // `returning` distinguishes cancelling back (focus the opener) from the first
  // render (focus nothing, or the page would steal focus on load).
  const [returning, setReturning] = useState(false);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (returning) openRef.current?.focus();
  }, [confirming, returning]);

  // Nothing at stake: one click, as before. A confirm here would be a speed bump
  // in front of nothing, which is how confirms get clicked through by reflex.
  if (upcomingBookings === 0) {
    return (
      <SubmitButton className={btnSecondaryCls} pendingLabel={copy.pending}>
        {copy.label}
      </SubmitButton>
    );
  }

  if (!confirming) {
    return (
      <button
        ref={openRef}
        type="button"
        className={btnSecondaryCls}
        onClick={() => setConfirming(true)}
      >
        {copy.label}
      </button>
    );
  }

  const held =
    upcomingBookings === null
      ? `Slate could not check how many upcoming appointments ${agentName} still holds.`
      : `${agentName} still holds ${upcomingBookings} upcoming ` +
        `${upcomingBookings === 1 ? "appointment" : "appointments"}.`;

  return (
    <div role="alert" className="rounded-sm border border-border bg-[var(--field)] p-4">
      <p className="text-sm text-fg">
        {held} {copy.effect}: the customers stay booked with {agentName} and will meet nobody.
        Reassign them in Coverage below, either before or after this.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <SubmitButton
          buttonRef={confirmRef}
          className={btnSecondaryCls}
          pendingLabel={copy.pending}
        >
          {copy.confirm}
        </SubmitButton>
        <button
          type="button"
          className={btnSecondaryCls}
          onClick={() => {
            setReturning(true);
            setConfirming(false);
          }}
        >
          Cancel
        </button>
        <a className="text-xs underline text-fg-muted" href={`/admin/agents/${agentId}#coverage`}>
          Go to Coverage
        </a>
      </div>
    </div>
  );
}
