"use client";

import { useEffect, useRef, useState } from "react";

import { btnSecondaryCls } from "@/components/ui/styles";

/**
 * The deactivate control on the agent profile, with a confirm when the agent
 * still holds upcoming appointments (#1215).
 *
 * Deactivating an agent and reassigning that agent's upcoming bookings were two
 * completely independent actions. Deactivating pulls the agent out of
 * availability and out of every picker, but leaves their already-booked future
 * appointments assigned to them, so a customer could arrive to meet an advisor
 * who had left. The only thing preventing that was an admin remembering the
 * coverage panel further down the same page.
 *
 * This is a CONFIRM, not a block (L54: a guard may refuse only what the system
 * genuinely cannot do). An agent really can leave mid-notice with the
 * appointments placed afterwards, and the coverage panel works on an
 * already-deactivated agent, so refusing would only ever stop the admin who
 * meant it. The monitor lane is the backstop for the paths with no human present
 * at all (the Salesforce roster sync deactivates with no UI).
 *
 * `upcomingBookings` is null when the count could not be read. That is NOT zero:
 * waving the admin through on a failed read would claim "nothing is booked"
 * having measured nothing, so an unreadable count gets the confirm too, with copy
 * that says which of the two happened.
 */
export default function DeactivateAgentButton({
  agentId,
  agentName,
  upcomingBookings,
}: {
  agentId: string;
  agentName: string;
  /** Active future appointments still assigned to this agent, or null when the
   *  count could not be read. */
  upcomingBookings: number | null;
}) {
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
    return <button className={btnSecondaryCls}>Deactivate account</button>;
  }

  if (!confirming) {
    return (
      <button
        ref={openRef}
        type="button"
        className={btnSecondaryCls}
        onClick={() => setConfirming(true)}
      >
        Deactivate account
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
        {held} Deactivating removes them from the booking pool, but it does not move those
        appointments: the customers stay booked with {agentName} and will meet nobody. Reassign them
        in Coverage below, either before or after this.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button ref={confirmRef} className={btnSecondaryCls}>
          Deactivate anyway
        </button>
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
