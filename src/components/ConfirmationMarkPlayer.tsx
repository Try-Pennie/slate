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
 * three outcomes its parent has a picture for. Everything else, the still coin
 * underneath, the reduced motion branch, and what happens when a lead's browser
 * never fetches this chunk at all, belongs to `ConfirmationMark`, which is the
 * one that is always on screen.
 */

// Before any player instance exists, which is what `setWasmUrl` asks for.
// Module scope rather than an effect: an effect runs after the first render, and
// the first render is what constructs the player.
setWasmUrl(CONFIRMATION_MARK.wasm);

export function ConfirmationMarkPlayer({
  onDrawing,
  onEnded,
  onFailed,
}: {
  /**
   * A frame has been PAINTED, which is the moment the still coin behind this
   * canvas has to get out of the way (#2560 shipped with both of them visible
   * at once). Mounting is not enough: there is a wasm and 65 frames to fetch
   * first, and hiding the still on mount would leave an empty panel for as long
   * as that takes. It fires on every frame; the parent takes only the first.
   */
  onDrawing: () => void;
  /** The animation reached its last frame. */
  onEnded: () => void;
  /** Nothing will ever draw, or nothing more will. */
  onFailed: () => void;
}) {
  const wire = useCallback(
    (player: DotLottie | null) => {
      if (!player) return;
      player.addEventListener("render", onDrawing);
      player.addEventListener("complete", onEnded);
      // Both the wasm and the animation fetch report here, and so does an
      // animation the player cannot read. There is no separate signal for which,
      // and there does not need to be: the still coin stands behind all three
      // the same way.
      player.addEventListener("loadError", onFailed);
      // Wired since the still is hidden while drawing: a canvas that loaded and
      // then stopped being able to paint used to sit over a coin that was
      // already there, and now it would sit over nothing.
      player.addEventListener("renderError", onFailed);
    },
    [onDrawing, onEnded, onFailed],
  );

  return (
    <DotLottieReact
      src={CONFIRMATION_MARK.animation}
      dotLottieRefCallback={wire}
      autoplay
      loop={false}
      // The canvas paints nothing where the frames are transparent, and it never
      // grows to cover the still coin behind it: measured on these assets, the
      // animation's mark draws 62px wide inside this box and the still's draws
      // 101px. So the parent HIDES the still while this is drawing rather than
      // relying on it being covered, which is what #2560 assumed and what Dan
      // saw fail on 2026-09-22.
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
