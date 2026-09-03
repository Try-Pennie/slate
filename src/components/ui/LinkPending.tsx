"use client";

import { useLinkStatus } from "next/link";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Instant feedback for a nav link whose destination fetches data (the internal
 * tabs are force-dynamic, so there's a beat before the new page commits). The
 * moment the link is clicked, show a small spinner on the tab itself plus the
 * global top progress bar — so the click never reads as "nothing happened."
 * Must render INSIDE the <Link> (useLinkStatus reports that link's nav state).
 *
 * TWO CUES FOR ONE NAVIGATION, ON PURPOSE (#1792). The top progress bar cannot
 * say WHICH link was clicked, and that is the one thing a person needs when a
 * sidebar of twenty entries takes a beat to commit; the per-link spinner carries
 * exactly that and nothing else. So it has to be legible enough to do the job,
 * which is why its colour is chosen by the surface it lands on rather than
 * inherited from whichever item happened to be clicked.
 *
 * Only ONE of them speaks. The load bar carries `role="status"`, the spinner is
 * `aria-hidden`, and a test pins that there is exactly one status region here:
 * two would announce the same wait twice.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <>
      {/* The spinner brings its own spacing (#1792). The sidebar's Link has no
          gap utility, so a spinner relying on its parent for one sat flush
          against the label's last letter. */}
      <Spinner size="sm" />
      <span className="pn-loadbar" role="status" aria-label="Loading the page" />
    </>
  );
}
