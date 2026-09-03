"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/ui/Spinner";

/** Below this a count would flicker on and off for a save that was simply fast. */
const SHOW_ELAPSED_AFTER_MS = 3_000;
/** Past this the wait has stopped being normal and the label says so. */
const SLOW_AFTER_MS = 20_000;

/**
 * Submit button that reports the form action's in-flight state, in the three
 * states a person has to be able to tell apart.
 *
 *  - **It started**: disabled, `aria-busy`, a spinner and a doing-it label, so a
 *    press never reads as nothing having happened.
 *  - **It is still alive**: after a few seconds the elapsed time ticks beside the
 *    label. A spinner alone looks identical whether the work is progressing,
 *    hung, or dead, which is the whole defect this exists to avoid.
 *  - **It failed or stalled**: past twenty seconds the label says so in words and
 *    announces it once to assistive tech. This covers the case where nothing comes
 *    back at all; a real failure comes back on the page as its own message.
 *
 * That last clause used to read "every admin action redirects with an outcome",
 * and it was not true (#1769). `setBookable` returned void and threw on a
 * refusal, on a route with no error boundary, so its most useful sentence was
 * scrubbed by Next in production and reached nobody. It redirects with an outcome
 * now, and the assumption is written as what this control covers rather than as a
 * claim about every action, because the next void action would inherit the claim
 * without inheriting the behaviour.
 *
 * Must live inside the `<form>`; `useFormStatus` reads the enclosing form.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
  slowLabel = "Still working",
  buttonRef,
  role,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
  /** For a caller that moves focus to this button (the pool exit confirm). */
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** For a submit that is also a menu item (the account menu's sign out). */
  role?: string;
  /** Shown in place of `pendingLabel` once the wait stops being normal. */
  slowLabel?: string;
}) {
  const { pending } = useFormStatus();
  // The clock is read only inside the interval callback, never in the effect body
  // and never during render: a setState in either is a cascading render, and a ref
  // read during render is the same hazard wearing a different hat. The count is
  // cleared in the CLEANUP, so a second submit never opens on the previous one's
  // elapsed time.
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => {
      clearInterval(timer);
      setElapsedMs(0);
    };
  }, [pending]);

  return (
    <button
      ref={buttonRef}
      type="submit"
      role={role}
      disabled={pending}
      aria-busy={pending}
      className={className}
    >
      {pending ? (
        <SubmitPending elapsedMs={elapsedMs} pendingLabel={pendingLabel} slowLabel={slowLabel} />
      ) : (
        children
      )}
    </button>
  );
}

/**
 * What the button SAYS while an action is in flight, as a function of how long it
 * has been (#1769).
 *
 * Split out and exported so the three states can be exercised by handing it an
 * elapsed time rather than by waiting for one. That is not a convenience: under
 * jsdom a state update from the interval drops the form's pending state, so a test
 * that submits and waits watches the button fall back to its idle label and
 * measures the harness rather than the button. **Measured in a real browser on
 * 2026-09-03**, with the action's POST held and never forwarded: 200ms and 1.5s
 * read "Saving…", 4s and 8s read "Saving…4s" and "Saving…8s", and from 21s it read
 * "Still working 21s" with "This is taking longer than usual." announced. So the
 * wiring works and it is jsdom that cannot hold the state; this component is the
 * part a test can still judge honestly.
 */
export function SubmitPending({
  elapsedMs,
  pendingLabel,
  slowLabel = "Still working",
}: {
  elapsedMs: number;
  pendingLabel: string;
  slowLabel?: string;
}) {
  const slow = elapsedMs >= SLOW_AFTER_MS;
  const showElapsed = elapsedMs >= SHOW_ELAPSED_AFTER_MS;
  const seconds = Math.floor(elapsedMs / 1_000);

  return (
    // No gap on the outer row: the Spinner carries its own margin (#1792), and a
    // gap here would add to it and space the cue further from its own label than
    // the label is from the count. The inner row keeps the gap for the words.
    <span className="inline-flex items-center">
      <Spinner />
      <span className="inline-flex items-center gap-2">
        {slow ? slowLabel : pendingLabel}
        {showElapsed && <span className="tabular-nums opacity-80">{seconds}s</span>}
        {/* Announced once, when the wait flips to slow. A live region on the
            ticking count itself would read a number out every second. */}
        <span className="sr-only" role="status" aria-live="polite">
          {slow ? "This is taking longer than usual." : ""}
        </span>
      </span>
    </span>
  );
}
