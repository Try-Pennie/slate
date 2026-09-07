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
  return (
    <>
      {/* THE SLOT IS RESERVED, NOT ADDED (#2045).
          
          The spinner used to appear as a new in-flow child the moment the link
          was clicked, so it took width from its siblings and everything to its
          right jumped sideways for as long as the page took to commit. In the
          header that is a row, so clicking "My Availability" shoved "Team
          Requests" across; the sidebar is a row too below `lg`. Dan: "I don't
          like that the loader pushes other nav items out of the way." Feedback
          that moves the things you did not click is the wrong shape.

          So the box is always in the layout and only becomes VISIBLE while
          pending: `visibility` keeps the geometry, so the click moves nothing.

          The two alternatives both lose here. Taking it out of flow means an
          absolutely positioned child, which a scrolling ancestor clips, and the
          sidebar nav is a horizontal scroller below `lg` (L566). Overlaying it
          on the label is not available at all: the header renders its label as a
          bare text node, so there is no element to dim or move behind.

          The cost, stated rather than hidden: every nav label carries the
          spinner's width permanently, whether or not anything is loading. That
          is a fixed, predictable gap. A shift that happens only at the moment
          somebody is trying to read where they are going is worse than a gap
          that is always the same.

          The spinner brings its own spacing (#1792): the sidebar's Link has no
          gap utility, so one relying on its parent for it sat flush against the
          label's last letter. That spacing is now the RESERVED width too. */}
      <span
        data-link-pending-slot=""
        data-pending={pending ? "" : undefined}
        aria-hidden="true"
        className="pn-link-pending"
      >
        <Spinner size="sm" />
      </span>
      {pending && (
        <span className="pn-loadbar" role="status" aria-label="Loading the page" />
      )}
    </>
  );
}
