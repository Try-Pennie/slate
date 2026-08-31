"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

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
 *    announces it once to assistive tech. A real failure comes back on the page
 *    as its own message (every admin action redirects with an outcome), so this
 *    covers the case where nothing comes back at all.
 *
 * Must live inside the `<form>`; `useFormStatus` reads the enclosing form.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
  slowLabel = "Still working",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
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

  const slow = elapsedMs >= SLOW_AFTER_MS;
  const showElapsed = elapsedMs >= SHOW_ELAPSED_AFTER_MS;
  const seconds = Math.floor(elapsedMs / 1_000);

  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={className}>
      {pending ? (
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
          />
          {slow ? slowLabel : pendingLabel}
          {showElapsed && (
            <span className="tabular-nums opacity-80">{seconds}s</span>
          )}
          {/* Announced once, when the wait flips to slow. A live region on the
              ticking count itself would read a number out every second. */}
          <span className="sr-only" role="status" aria-live="polite">
            {slow ? "This is taking longer than usual." : ""}
          </span>
        </span>
      ) : (
        children
      )}
    </button>
  );
}
