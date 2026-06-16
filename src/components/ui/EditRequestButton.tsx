"use client";

import { useRouter } from "next/navigation";

/**
 * Enters edit mode without the jarring scroll. A plain <a href="...#time-off">
 * navigates, which resets the scroll to the top and then animates back down to
 * the anchor. Instead we push the edit URL with scroll:false (no reset, no hash
 * jump); the form scrolls itself smoothly into view once it mounts in edit mode.
 */
export function EditRequestButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.push(`/me?edit=${requestId}`, { scroll: false })}
      className="rounded-md px-3 py-1.5 text-sm font-semibold text-fg transition-colors hover:bg-pennie-sky-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pennie-sky dark:hover:bg-accent/15"
    >
      Edit
    </button>
  );
}
