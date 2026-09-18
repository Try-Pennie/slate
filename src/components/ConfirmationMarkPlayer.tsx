"use client";

import { useCallback } from "react";
import { DotLottieReact, setWasmUrl, type DotLottie } from "@lottiefiles/dotlottie-react";
import { CONFIRMATION_MARK } from "@/lib/booking/confirmation-mark";

/**
 * The dotLottie half of the confirmation mark (#2560), kept in its own module so
 * `ConfirmationMark` can reach it through a dynamic `import()`.
 *
 * Nothing in the booker's first load may import this file: the player and its
 * wasm are about a megabyte and a half, and the booker's first screen is a date
 * picker that has no use for either. `scripts/test-confirmation-mark-assets.ts`
 * fails the build on a static import of it.
 *
 * This component owns ONE thing, the wiring from the player's own events to the
 * two outcomes its parent has a picture for. Everything else, the still coin
 * underneath, the reduced motion branch, and what happens when a lead's browser
 * never fetches this chunk at all, belongs to `ConfirmationMark`, which is the
 * one that is always on screen.
 */

// Before any player instance exists, which is what `setWasmUrl` asks for.
// Module scope rather than an effect: an effect runs after the first render, and
// the first render is what constructs the player.
setWasmUrl(CONFIRMATION_MARK.wasm);

export function ConfirmationMarkPlayer({
  onEnded,
  onFailed,
}: {
  /** The animation reached its last frame. */
  onEnded: () => void;
  /** The wasm or the animation could not be loaded, so nothing will ever draw. */
  onFailed: () => void;
}) {
  const wire = useCallback(
    (player: DotLottie | null) => {
      if (!player) return;
      player.addEventListener("complete", onEnded);
      // Both the wasm and the animation fetch report here, and so does an
      // animation the player cannot read. There is no separate signal for which,
      // and there does not need to be: the still coin is already on screen and
      // covers all three the same way.
      player.addEventListener("loadError", onFailed);
    },
    [onEnded, onFailed],
  );

  return (
    <DotLottieReact
      src={CONFIRMATION_MARK.animation}
      dotLottieRefCallback={wire}
      autoplay
      loop={false}
      // The canvas paints nothing where the frames are transparent, so the still
      // coin shows through until the animation covers it.
      width={CONFIRMATION_MARK.size}
      height={CONFIRMATION_MARK.size}
      aria-hidden="true"
      // This lands on the wrapper DotLottieReact draws around the canvas, and it
      // has to be given one: with no className that wrapper takes an inline
      // width and height of 100%, and with one it takes nothing at all.
      className="h-full w-full"
    />
  );
}
