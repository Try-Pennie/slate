"use client";

import { useLinkStatus } from "next/link";

/**
 * Instant feedback for a nav link whose destination fetches data (the internal
 * tabs are force-dynamic, so there's a beat before the new page commits). The
 * moment the link is clicked, show a small spinner on the tab itself plus the
 * global top progress bar — so the click never reads as "nothing happened."
 * Must render INSIDE the <Link> (useLinkStatus reports that link's nav state).
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
      />
      <span className="pn-loadbar" role="status" aria-label="Loading the page" />
    </>
  );
}
