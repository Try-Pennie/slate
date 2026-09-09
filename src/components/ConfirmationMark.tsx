"use client";

import { useState, useSyncExternalStore } from "react";
import { CONFIRMATION_MARK } from "@/lib/booking/confirmation-mark";

const REDUCED = "(prefers-reduced-motion: reduce)";

/** Subscribing to the media query directly, rather than copying its answer into
 *  state from an effect. A setState in an effect is a second render every time
 *  and the lint refuses it; this also keeps the answer live, so a lead who
 *  changes the system setting with the page open gets the still. */
function subscribe(onChange: () => void): () => void {
  const q = window.matchMedia?.(REDUCED);
  q?.addEventListener?.("change", onChange);
  return () => q?.removeEventListener?.("change", onChange);
}

function prefersMotion(): boolean {
  return window.matchMedia?.(REDUCED)?.matches !== true;
}

/** What the SERVER renders. The still, deliberately: it is correct for everyone,
 *  so a lead whose client script never runs keeps a real picture rather than an
 *  element that was going to be replaced (L597). */
function motionOnServer(): boolean {
  return false;
}

/**
 * The check mark on the confirmation screen (#2163). See
 * `@/lib/booking/confirmation-mark` for what the two assets are, why the panel is
 * painted that exact cream, and why it does not rest on the video's own last
 * frame.
 *
 * **Reduced motion is handled HERE, not by the stylesheet.** The global guard in
 * globals.css sets `animation-duration` and `transition-duration`, which are CSS
 * properties. A playing video is neither, so it would run at full speed for
 * somebody who has asked their system for less motion, with a rule that reads as
 * covering all motion sitting directly above it.
 *
 * The still is ALWAYS in the tree, underneath. That is what makes the ending a
 * reveal rather than a swap, and it means a browser that cannot decode the video
 * (headless Chromium ships no H.264 decoder at all, and it is not alone) shows the
 * right picture rather than an empty box, with the poster covering the same case
 * for the frames before the first one arrives.
 */
export function ConfirmationMark() {
  const playable = useSyncExternalStore(subscribe, prefersMotion, motionOnServer);
  const [ended, setEnded] = useState(false);

  return (
    <div
      className="mx-auto flex max-w-72 items-center justify-center rounded-xl px-6 py-5"
      style={{ background: CONFIRMATION_MARK.ground }}
    >
      <div className="relative h-36 w-36">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={CONFIRMATION_MARK.still}
          alt=""
          aria-hidden="true"
          width={CONFIRMATION_MARK.size}
          height={CONFIRMATION_MARK.size}
          className="absolute inset-0 h-36 w-36 object-contain"
        />
        {playable && (
          <video
            src={CONFIRMATION_MARK.video}
            poster={CONFIRMATION_MARK.still}
            width={CONFIRMATION_MARK.size}
            height={CONFIRMATION_MARK.size}
            autoPlay
            muted
            playsInline
            // No `loop`: it plays once and gives way to the still beneath it.
            onEnded={() => setEnded(true)}
            data-ended={ended ? "true" : "false"}
            aria-hidden="true"
            style={{ transitionDuration: `${CONFIRMATION_MARK.settleMs}ms` }}
            className={`absolute inset-0 h-36 w-36 object-contain transition-opacity ${
              ended ? "opacity-0" : "opacity-100"
            }`}
          />
        )}
      </div>
    </div>
  );
}
