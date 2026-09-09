"use client";

import { COVERAGE_PANEL_NAME } from "@/lib/booking/coverage-panel-copy";
import {
  COVERAGE_CHOICE_FIELD,
  COVERAGE_CHOICE_LEAVE,
  COVERAGE_CHOICE_MOVE,
} from "@/lib/offboarding/coverage-choice";
import { btnDangerCls, btnSecondaryCls } from "@/components/ui/styles";
import { ConfirmAction } from "@/components/ui/ConfirmAction";
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
 * admin remembering the panel further down the same page that moves them.
 *
 * One component for both controls on purpose: they ask the identical question and
 * a second copy would drift. Each speaks in the language of the control that was
 * pressed, because a toggle that warns about "deactivating" reads as the wrong
 * dialog.
 *
 * This is a CONFIRM, not a block (L54: a guard may refuse only what the system
 * genuinely cannot do). An agent really can leave mid-notice with the
 * appointments placed afterwards, and the move panel works on an agent who has
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

/**
 * Which of the two wears the destructive treatment (#1875).
 *
 * Deactivating only. Making somebody not bookable is a switch that is flipped
 * both ways in the ordinary course of a week, and a rose control on an everyday
 * toggle is how a reader learns to ignore the colour, which costs the warning
 * exactly where it is needed. Deactivating says a person has left, sets
 * `bookable = false` in the same write, and reactivating does not restore it, so
 * it is not a switch at all.
 */
const TREATMENT: Record<PoolExitAction, string> = {
  deactivate: btnDangerCls,
  not_bookable: btnSecondaryCls,
};

const COPY: Record<
  PoolExitAction,
  { label: string; confirm: string; effect: string; pending: string }
> = {
  deactivate: {
    label: "Deactivate account",
    // #2124: the confirm names the OUTCOME it produces rather than saying
    // "anyway", because there are two ways forward now and "anyway" cannot tell
    // them apart.
    confirm: "Move them and deactivate",
    // Names the action rather than saying "Saving", so a press never reads as
    // nothing having happened while the work runs (#1769).
    pending: "Moving them and deactivating",
    effect: "",
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
  const treatment = TREATMENT[action];

  // Nothing at stake: one click, as before. A confirm here would be a speed bump
  // in front of nothing, which is how confirms get clicked through by reflex.
  //
  // #1875: it still wears the destructive treatment. The confirm is skipped
  // because no APPOINTMENT is stranded, not because the press is reversible, and
  // an empty calendar is exactly the case Dan met: one click, on a neutral
  // button, to say somebody has left.
  if (upcomingBookings === 0) {
    return (
      <SubmitButton className={treatment} pendingLabel={copy.pending}>
        {copy.label}
      </SubmitButton>
    );
  }

  const held =
    upcomingBookings === null
      ? `Slate could not check how many upcoming appointments ${agentName} still holds.`
      : `${agentName} still holds ${upcomingBookings} upcoming ` +
        `${upcomingBookings === 1 ? "appointment" : "appointments"}.`;

  // The open/confirm/cancel swap and its focus move live in `ConfirmAction`
  // (#1873), because applying company default hours needed the identical
  // interaction and two copies of it would drift. What stays here is the COPY,
  // which is the half that differs per control.
  //
  // #2124: DEACTIVATING ASKS. Dan: "can we add a warning asking if they'd like to
  // sweep? that way it's a deliberate choice." Both answers go ahead, so both are
  // decisions rather than ways out, and the message states what each one leaves
  // behind rather than only warning about the appointments.
  //
  // Moving is FIRST and takes the focus, because it is the outcome that does not
  // strand a customer (L609). Leaving is offered rather than hidden: an agent
  // really can leave mid notice with the appointments deliberately kept, and the
  // panel below still moves them later either way.
  //
  // The bookable toggle gets NO choice. It is a pause: the person still works
  // here, so moving their appointments to somebody else is not what that control
  // means, and offering it would put a departure's decision on an everyday switch.
  const isDeactivate = action === "deactivate";

  return (
    <ConfirmAction
      label={copy.label}
      confirmLabel={copy.confirm}
      pendingLabel={copy.pending}
      className={treatment}
      confirmName={isDeactivate ? COVERAGE_CHOICE_FIELD : undefined}
      confirmValue={isDeactivate ? COVERAGE_CHOICE_MOVE : undefined}
      alternative={
        isDeactivate
          ? {
              label: "Deactivate and leave them",
              pendingLabel: "Deactivating account",
              name: COVERAGE_CHOICE_FIELD,
              value: COVERAGE_CHOICE_LEAVE,
            }
          : undefined
      }
      message={
        isDeactivate ? (
          <>
            {held} Moving them hands each one to another advisor at the same time, and
            the customer gets one short note. Leaving them means the customers stay
            booked with {agentName} and will meet nobody.
          </>
        ) : (
          <>
            {held} {copy.effect}: the customers stay booked with {agentName} and will meet
            nobody. Move them in the panel below, either before or after this.
          </>
        )
      }
      extra={
        <a className="text-xs underline text-fg-muted" href={`/admin/agents/${agentId}#coverage`}>
          {`Go to ${COVERAGE_PANEL_NAME}`}
        </a>
      }
    />
  );
}
