"use client";

import { useRouter } from "next/navigation";

/**
 * Enters edit mode responsively. A plain <a href="...#time-off"> resets scroll
 * to the top then animates back down (jarring), and waiting for the navigation
 * to re-render before scrolling reads as "nothing happened". So we snap to the
 * form instantly on click for immediate feedback, then push the edit URL with
 * scroll:false (no reset) — the form is already in view when it mounts in edit
 * mode and fills in.
 */
export function EditRequestButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        document
          .getElementById("ooo-form")
          ?.scrollIntoView({ behavior: "instant", block: "start" });
        router.push(`/me?edit=${requestId}`, { scroll: false });
      }}
      className="rounded-md px-3 py-1.5 text-sm font-semibold text-fg transition-colors hover:bg-pennie-sky-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky dark:hover:bg-accent/15"
    >
      Edit
    </button>
  );
}
