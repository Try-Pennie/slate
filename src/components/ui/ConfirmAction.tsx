"use client";

import { useEffect, useRef, useState } from "react";

import { SubmitButton } from "@/components/ui/SubmitButton";

/**
 * A control that asks before it submits, in place rather than in a dialog (#1873).
 *
 * ONE implementation of the interaction, two sets of copy. The pool exit controls
 * (#1215) had all of this inline, and applying company default hours needed the
 * same thing: an opener that submits nothing, a message the reader can act on, a
 * confirm that submits, and a way back. A second copy would have drifted, and the
 * half that drifts first is the focus handling, because nothing on screen reports
 * it.
 *
 * THE FOCUS MOVE IS THE PART WORTH READING. The opener and the confirm swap
 * places in the DOM, so without moving focus deliberately it lands on the
 * document body: a keyboard or screen reader user is dropped out of the flow they
 * just started and cannot tab forward to the message, because it sits ABOVE where
 * they now are. `returning` is what separates cancelling back to the opener from
 * the first render, where focusing anything would have the page steal focus on
 * load.
 *
 * The message carries `role="alert"`, so it is announced when it appears rather
 * than waiting for the reader to find it.
 *
 * `formAction` lets the confirm submit its enclosing form to a DIFFERENT server
 * action than the form's own. That is what allows a form with unsaved edits to
 * host a control that discards them: the control has to sit inside the form to
 * know the edits exist, and it must not run the form's own save.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  pendingLabel,
  message,
  className,
  extra,
  formAction,
}: {
  /** The opener's text. Submits nothing. */
  label: string;
  /** The confirm submit's text. Says what it is about to do, never just "Yes". */
  confirmLabel: string;
  pendingLabel: string;
  /** What the reader has to decide on. Must say what the action replaces or
   *  destroys, rather than asking a generic "are you sure". */
  message: React.ReactNode;
  /** Worn by the opener and the confirm, so the two read as the same control. */
  className?: string;
  /** An extra way out beside Cancel (a link to the panel that fixes the cause). */
  extra?: React.ReactNode;
  formAction?: (form: FormData) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [returning, setReturning] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (returning) openRef.current?.focus();
  }, [confirming, returning]);

  if (!confirming) {
    return (
      <button
        ref={openRef}
        type="button"
        className={className}
        onClick={() => setConfirming(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <div role="alert" className="rounded-sm border border-border bg-[var(--field)] p-4">
      <p className="text-sm text-fg">{message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <SubmitButton
          buttonRef={confirmRef}
          className={className}
          pendingLabel={pendingLabel}
          formAction={formAction}
        >
          {confirmLabel}
        </SubmitButton>
        <button
          type="button"
          className={className}
          onClick={() => {
            setReturning(true);
            setConfirming(false);
          }}
        >
          Cancel
        </button>
        {extra}
      </div>
    </div>
  );
}
