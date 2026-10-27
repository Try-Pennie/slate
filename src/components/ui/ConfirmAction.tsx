"use client";

import { useEffect, useRef, useState } from "react";

import { SubmitButton } from "@/components/ui/SubmitButton";
import { btnSecondaryCls } from "@/components/ui/styles";

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
/** What the question needs, shared by `ConfirmAction` and a caller drawing it elsewhere. */
type QuestionProps = {
  /** The confirm submit's text. Says what it is about to do, never just "Yes". */
  confirmLabel: string;
  pendingLabel: string;
  /** What the reader has to decide on. Must say what the action replaces or
   *  destroys, rather than asking a generic "are you sure". */
  message: React.ReactNode;
  /**
   * Worn by the opener and the confirm, so the two read as the same control.
   *
   * NOT by Cancel, which is always neutral (#1875). Backing out is never the
   * destructive choice, and a caller passing a destructive treatment would
   * otherwise paint the safe way out in the same warning colour as the thing it
   * is a way out of.
   */
  className?: string;
  /** An extra way out beside Cancel (a link to the panel that fixes the cause). */
  extra?: React.ReactNode;
  formAction?: (form: FormData) => Promise<void>;
  /**
   * The name and value the primary decision posts, when there are two of them and
   * the server has to tell which was pressed (#2124).
   */
  confirmName?: string;
  confirmValue?: string;
  /**
   * A SECOND way to go ahead, differently (#2124).
   *
   * Not a way out: Cancel is the way out, and it stays separate and neutral. This
   * is for a press whose consequence the reader has to choose between, where
   * deciding either way without asking would be the defect. Deactivating an agent
   * who holds upcoming bookings is the case it was built for: sweeping silently
   * moves customers' appointments out from under the admin, and not sweeping
   * strands those customers with an advisor who has left.
   *
   * It wears the caller's treatment, like the primary, because both go ahead.
   * Painting one of two ways forward in the neutral treatment would read as the
   * safe way out, which is a lie about what it does.
   */
  alternative?: {
    label: string;
    pendingLabel: string;
    name: string;
    value: string;
  };
};

export function ConfirmAction({
  label,
  initiallyOpen = false,
  ...question
}: QuestionProps & {
  /** The opener's text. Submits nothing. */
  label: string;
  /**
   * Draw the question already open (#4264), for a design's preview frame
   * (docs/design/coordinator-admin.html, f-confirm-on). It takes no focus on load: the
   * focus move below follows a PRESS, and a page that seized focus on arrival would
   * strand a keyboard reader somewhere they did not choose.
   */
  initiallyOpen?: boolean;
}) {
  const [confirming, setConfirming] = useState(initiallyOpen);
  const [returning, setReturning] = useState(false);
  const [pressed, setPressed] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming && pressed) confirmRef.current?.focus();
    else if (returning) openRef.current?.focus();
  }, [confirming, pressed, returning]);

  if (!confirming) {
    return (
      <button
        ref={openRef}
        type="button"
        className={question.className}
        onClick={() => {
          setPressed(true);
          setConfirming(true);
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <ConfirmQuestion
      {...question}
      confirmRef={confirmRef}
      onCancel={() => {
        setReturning(true);
        setConfirming(false);
      }}
    />
  );
}

/**
 * The question itself (#4264): the message, the decision or decisions, and Cancel.
 *
 * `ConfirmAction` draws it in the opener's place. A caller that has to draw it somewhere
 * else, such as a table asking about one row in a row of its own beneath it
 * (`CoordinatorList`, D12 in docs/design/coordinator-admin.html), draws this and owns the
 * opener and the focus move itself, so the question is still drawn one way.
 */
export function ConfirmQuestion({
  confirmLabel,
  pendingLabel,
  message,
  className,
  extra,
  formAction,
  confirmName,
  confirmValue,
  alternative,
  confirmRef,
  onCancel,
}: QuestionProps & {
  /** Where the confirm's element is handed, so the caller can move focus into it. */
  confirmRef?: React.Ref<HTMLButtonElement>;
  /** Cancel was pressed: the caller closes the question and puts focus back. */
  onCancel: () => void;
}) {
  /**
   * Which decision was taken, when there are two (#2124).
   *
   * `useFormStatus` reports the FORM, not the button, so both submits go pending
   * together and each swaps to ITS OWN pending label. Pressing "leave" would then
   * leave the other button reading "Moving them and deactivating", which claims
   * the opposite of what is happening, on the one screen where the difference
   * between the two IS the decision (L11).
   *
   * So the one that was not taken is removed on the press. Cleared on cancel, or
   * a reader who backs out and reopens is offered only the choice they abandoned.
   */
  const [taken, setTaken] = useState<"primary" | "alternative" | null>(null);
  return (
    <div role="alert" className="rounded-sm border border-border bg-[var(--field)] p-4">
      <p className="text-sm text-fg">{message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {taken !== "alternative" && (
          <SubmitButton
            buttonRef={confirmRef}
            className={className}
            pendingLabel={pendingLabel}
            formAction={formAction}
            name={confirmName}
            value={confirmValue}
            onPress={() => setTaken("primary")}
          >
            {confirmLabel}
          </SubmitButton>
        )}
        {alternative && taken !== "primary" && (
          // Second, because the first is the one a reader should take and focus
          // lands there. Ordering by what is done most often, and by which
          // consequence is the safer one, rather than by the shape of the data
          // (L609).
          <SubmitButton
            className={className}
            pendingLabel={alternative.pendingLabel}
            formAction={formAction}
            name={alternative.name}
            value={alternative.value}
            onPress={() => setTaken("alternative")}
          >
            {alternative.label}
          </SubmitButton>
        )}
        <button
          type="button"
          className={btnSecondaryCls}
          onClick={() => {
            setTaken(null);
            onCancel();
          }}
        >
          Cancel
        </button>
        {extra}
      </div>
    </div>
  );
}
