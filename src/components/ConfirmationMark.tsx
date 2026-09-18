"use client";

import { useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
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

type Player = ComponentType<{
  onEnded: () => void;
  onFailed: () => void;
}>;

/**
 * The player, its wasm and the 65 animation frames, fetched only once somebody
 * is looking at the confirmation screen.
 *
 * A static import would put the player in the booker's FIRST load, which is a
 * date picker: every lead would pay for it and only the ones who book would ever
 * see it draw.
 */
async function loadPlayer(): Promise<Player> {
  return (await import("@/components/ConfirmationMarkPlayer")).ConfirmationMarkPlayer;
}

/**
 * The check mark on the confirmation screen (#2163, drawn by dotLottie since
 * #2560). See `@/lib/booking/confirmation-mark` for what the assets are, why
 * both of them are transparent, and why it does not rest on the animation's own
 * last frame.
 *
 * **Reduced motion is handled HERE, not by the stylesheet.** The global guard in
 * globals.css sets `animation-duration` and `transition-duration`, which are CSS
 * properties. A canvas painting itself frame by frame is neither, so it would run
 * at full speed for somebody who has asked their system for less motion, with a
 * rule that reads as covering all motion sitting directly above it.
 *
 * **The still is ALWAYS in the tree, underneath.** That is what makes the ending
 * a reveal rather than a swap, and it is the whole answer to every way the player
 * can be absent: a chunk that never arrives, a wasm that will not load, an
 * animation that will not fetch, and a lead who asked for less motion all leave
 * the same correct picture rather than an empty panel.
 */
export function ConfirmationMark() {
  const playable = useSyncExternalStore(subscribe, prefersMotion, motionOnServer);
  const [player, setPlayer] = useState<Player | null>(null);
  const [phase, setPhase] = useState<"playing" | "ended" | "failed">("playing");

  useEffect(() => {
    if (!playable) return;
    let live = true;
    loadPlayer().then(
      (component) => {
        // Stored behind a function, or React would call it as an updater.
        if (live) setPlayer(() => component);
      },
      () => {
        // The safe path, and the reason this is not a fail-loud site: the still
        // coin is already drawn and stays drawn, so a lead who never gets this
        // chunk sees the same mark as a lead whose system asked for less motion.
        // There is nothing for them to do and nothing for anyone to fix in the
        // moment, so it must not throw out of a render that is otherwise fine.
        if (live) setPhase("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [playable]);

  const Player = player;

  return (
    <div className="mx-auto flex max-w-72 items-center justify-center px-6 py-5">
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
        {playable && Player && phase !== "failed" ? (
          // The positioning and the fade are on a layer THIS component owns.
          // DotLottieReact renders a wrapper of its own and puts `className` on
          // it, so handing it these classes would work by accident, and it drops
          // `style` entirely whenever a className is set, so the settle duration
          // would silently never apply.
          <div
            data-testid="confirmation-mark-layer"
            aria-hidden="true"
            style={{ transitionDuration: `${CONFIRMATION_MARK.settleMs}ms` }}
            className={`absolute inset-0 h-36 w-36 transition-opacity ${
              phase === "ended" ? "opacity-0" : "opacity-100"
            }`}
          >
            <Player onEnded={() => setPhase("ended")} onFailed={() => setPhase("failed")} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
