"use client";

import { useEffect, useId, useRef, useState } from "react";

import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnDangerCls, btnSecondaryCls } from "@/components/ui/styles";

/**
 * The two step confirm for an irreversible act, in ONE place (#2455).
 *
 * The agent's Cancel on /me/time-off and the manager's Decline on /admin/ooo are
 * the two irreversible controls in the time off flow, and each carried its own
 * copy of the same hand rolled markup: the same panel, the same ghost constant,
 * and character for character the same destructive button
 * (`bg-error/10 text-error hover:bg-error/20`). Correcting one alone would have
 * left the two diverged while each still read as reasonable on its own, which is
 * why this arrived as the component and the guard together
 * (`scripts/test-destructive-confirm.ts`) rather than as a class string edit
 * (L613).
 *
 * THE GROUND IS NEUTRAL AND THAT IS MEASURED, NOT PREFERRED. Both copies painted
 * a rose label on a rose wash on a second rose wash, so what the label actually
 * sat on depended on the page behind it: 3.88:1 on the beige page and 4.17:1 on a
 * card, against the 4.5:1 that small text needs. There is no alpha that fixes it,
 * because the rose wash pale enough to keep a rose label at 4.5:1 is 1.04:1
 * against the beige page and is therefore no surface at all. So the panel takes
 * the neutral field colour and the destructive signal is carried by the rose
 * BORDER and by the button, both of which are full strength rose and both of
 * which are asserted in `scripts/test-contrast.ts`.
 *
 * THE WAY OUT IS NEVER DESTRUCTIVE. Backing out is the safe choice, so it wears
 * the neutral button; painting it rose would give the same warning colour to the
 * thing and to the escape from it (#1875).
 *
 * THE FOCUS MOVE IS THE PART THAT WOULD HAVE DRIFTED. The opener and the confirm
 * swap places in the DOM, so with nothing moving focus deliberately a keyboard or
 * screen reader user is dropped onto the document body, below a question that has
 * just appeared above them. Neither hand rolled copy did it. `returning` is what
 * separates backing out (where focus belongs on the opener again) from the first
 * render, where focusing anything would have the page steal focus on load.
 */
// restore-optin-ok: this renders its own form and takes its action as a prop, so
// it is not inside the wrapper yet. It arrives with #1998.
export function DestructiveConfirm({
  openLabel,
  beside,
  question,
  consequence,
  dismissLabel,
  confirmLabel,
  pendingLabel,
  action,
  hidden,
  panelClassName = "",
  openGroupClassName = "flex shrink-0 items-center gap-2",
}: {
  /** The opener's words. It arms the confirm and submits nothing. */
  openLabel: string;
  /**
   * A control that lives beside the opener and disappears with it, so the
   * confirm REPLACES the row's controls instead of crowding in beside them.
   */
  beside?: React.ReactNode;
  /**
   * What the reader is deciding, naming the act and how much it is about.
   *
   * It is the group's accessible name, so a screen reader hears what is being
   * confirmed rather than two buttons reading "Keep it" and "Yes, cancel".
   */
  question: string;
  /**
   * What becomes of it, derived from the state the press is about to change
   * rather than a generic "this cannot be undone" (L180). It is the group's
   * description.
   */
  consequence: string;
  /** The way out. Never named after the act it backs out of. */
  dismissLabel: string;
  /** The destructive submit's words. Says what it does, never just "Yes". */
  confirmLabel: string;
  pendingLabel: string;
  /**
   * The server action, for a caller that has no form of its own.
   *
   * Left out by a caller whose confirm already sits INSIDE a form, which is the
   * only way a control can see what that form holds: the manager's Decline
   * submits the rejection note typed beside it.
   */
  action?: (form: FormData) => void;
  /** Hidden inputs that travel with the confirm, inside whichever form it is in. */
  hidden?: React.ReactNode;
  /** Layout only, for the width the panel takes in its row. */
  panelClassName?: string;
  /** Layout only, for how the opener sits beside its neighbour. */
  openGroupClassName?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [returning, setReturning] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  const consequenceId = useId();

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (returning) openRef.current?.focus();
  }, [confirming, returning]);

  if (!confirming) {
    return (
      <div className={openGroupClassName}>
        {beside}
        <button
          ref={openRef}
          type="button"
          className={btnSecondaryCls}
          onClick={() => setConfirming(true)}
        >
          {openLabel}
        </button>
      </div>
    );
  }

  const panel = (
    <div
      role="group"
      aria-labelledby={questionId}
      aria-describedby={consequenceId}
    >
      {hidden}
      <p id={questionId} className="text-sm font-semibold text-fg">
        {question}
      </p>
      {/*
        Full strength graphite, not `text-fg-muted`: this is the sentence that
        states the damage, so it must not be the faintest thing in the group.
      */}
      <p id={consequenceId} className="mt-1 text-sm text-fg">
        {consequence}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className={btnSecondaryCls}
          onClick={() => {
            setReturning(true);
            setConfirming(false);
          }}
        >
          {dismissLabel}
        </button>
        <SubmitButton
          buttonRef={confirmRef}
          className={btnDangerCls}
          pendingLabel={pendingLabel}
        >
          {confirmLabel}
        </SubmitButton>
      </div>
    </div>
  );

  const shell = `pn-confirm-enter rounded-lg border border-[var(--error)] bg-[var(--field)] p-3 ${panelClassName}`.trim();

  return action ? (
    <form action={action} className={shell} autoComplete="off">
      {panel}
    </form>
  ) : (
    <div className={shell}>{panel}</div>
  );
}
