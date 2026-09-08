"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * Enters edit mode responsively. A plain <a href="/me/time-off?edit=..."> resets scroll
 * to the top then animates back down (jarring), and waiting for the navigation
 * to re-render before scrolling reads as "nothing happened". So we snap to the
 * form instantly on click for immediate feedback, then push the edit URL with
 * scroll:false (no reset) — the form is already in view when it mounts in edit
 * mode and fills in.
 *
 * The form-fill waits on a server round-trip, which can take a beat. We've
 * already snapped away from this button, so a spinner on it wouldn't be seen —
 * instead a top-of-viewport progress bar marks the in-flight nav (useTransition
 * keeps isPending true until the new content commits).
 */
export function EditRequestButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <>
      {pending && (
        <div
          className="pn-loadbar"
          role="status"
          aria-label="Opening your request to edit"
        />
      )}
      <button
        type="button"
        aria-busy={pending}
        onClick={() => {
          document
            .getElementById("ooo-form")
            ?.scrollIntoView({ behavior: "instant", block: "start" });
          startTransition(() => {
            router.push(`/me/time-off?edit=${requestId}`, { scroll: false });
          });
        }}
        className="rounded-md px-3 py-1.5 text-sm font-semibold text-fg transition-colors hover:bg-pennie-sky-soft dark:hover:bg-accent/15"
      >
        Edit
      </button>
    </>
  );
}
