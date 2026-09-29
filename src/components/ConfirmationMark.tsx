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
  onDrawing: () => void;
  onEnded: () => void;
  onFailed: () => void;
}>;

/**
 * The player, its wasm and the 65 animation frames, fetched only once somebody
 * has picked a time (see `preloadConfirmationMark`) or is looking at the
 * confirmation screen.
 *
 * A static import would put the player in the booker's FIRST load, which is a
 * date picker: every lead would pay for it and only the ones who book would ever
 * see it draw.
 *
 * One promise for the page, so the early load and the screen share one fetch. A
 * rejection is forgotten rather than kept, so a chunk that failed once on a
 * flaky connection is asked for again by the next caller.
 */
type PlayerModule = {
  ConfirmationMarkPlayer: Player;
  warmConfirmationMarkPlayer: () => Promise<void>;
};

let playerPromise: Promise<PlayerModule> | null = null;

function loadPlayer(): Promise<PlayerModule> {
  playerPromise ??= import("@/components/ConfirmationMarkPlayer").then(
    (m) => m,
    (err: unknown) => {
      playerPromise = null;
      throw err;
    },
  );
  return playerPromise;
}

let warmed = false;
/** Held so the early request for the still is not collected before it lands. */
let stillWarm: HTMLImageElement | null = null;

/**
 * Start loading the animation BEFORE the confirmation screen (#2636), called
 * once a lead has picked a time and is filling in their details.
 *
 * On an iPhone in Low Power Mode the player took long enough to arrive that Dan
 * watched the fallback coin appear and then be swapped for the drawing. The
 * screen no longer swaps (see `holdMs`), so a late load now costs the drawing
 * rather than causing a glitch, and this is what keeps that rare.
 *
 * It used to warm only the HTTP cache, and that was not enough (Dan, rebooking,
 * 2026-09-29: "it was just white for a second before the coin showed up"). The
 * files are served `max-age=0, must-revalidate`, so the player still paid a
 * round trip for each and compiled its wasm on the confirmation screen, and on a
 * slowed phone profile it never painted inside the hold. So the player now warms
 * ITSELF (`warmConfirmationMarkPlayer`: the wasm compiled, the animation held in
 * memory), and the still coin is requested here too, since it is what shows
 * whenever the drawing is late.
 *
 * Every failure here is deliberately dropped: this is a head start and nothing
 * more. The confirmation screen makes its own request and shows the still coin
 * when that one fails, which is where a failure has somewhere true to land.
 * `force` is for tests, which need to run the once-only warm more than once.
 */
export function preloadConfirmationMark({ force = false }: { force?: boolean } = {}): void {
  if (typeof window === "undefined" || !prefersMotion()) return;
  if (warmed && !force) return;
  warmed = true;
  loadPlayer()
    .then((m) => m.warmConfirmationMarkPlayer())
    // swallow-ok: a head start only; the player falls back to fetching its URL and the screen shows the still coin when that fails
    .catch(() => {
      // Forgotten, so the next call (another time picked) tries again rather
      // than one flaky moment costing the drawing for the whole visit.
      warmed = false;
    });
  stillWarm = new Image();
  stillWarm.src = CONFIRMATION_MARK.still;
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
 * **A lead sees the drawing or the still coin, never one then the other then
 * the first again** (#2636). Dan, on his phone in Low Power Mode on 2026-09-24:
 * the coin showed, was swapped for the drawing, then came back, and "it looked
 * broken". The still used to stand behind the LOADING state as well, so any
 * load slow enough to see put a coin up, took it away, and brought it back.
 *
 * So the spot is held EMPTY for `holdMs` while the player loads (the box keeps
 * its size, so nothing moves). If the first frame paints inside that, the
 * drawing plays alone and settles on the still. If it does not, the still goes
 * up and STAYS: the player is unmounted and a late frame changes nothing. A
 * failure to load, a render that dies part way, and a lead who asked for less
 * motion all go straight to the still without waiting.
 *
 * Why the still is never behind the drawing: both are transparent, and the
 * still's coin draws 101px wide against the drawing's 62px, so it shows through
 * the whole 2.167 seconds (the #2560 regression, 2026-09-22).
 */
export function ConfirmationMark() {
  const playable = useSyncExternalStore(subscribe, prefersMotion, motionOnServer);
  const [player, setPlayer] = useState<Player | null>(null);
  const [phase, setPhase] = useState<"holding" | "drawing" | "ended" | "still">("holding");

  useEffect(() => {
    if (!playable) return;
    let live = true;
    loadPlayer().then(
      (m) => {
        // Stored behind a function, or React would call it as an updater.
        if (live) setPlayer(() => m.ConfirmationMarkPlayer);
      },
      () => {
        // The safe path, and the reason this is not a fail-loud site: the still
        // coin goes up and stays, which is the same mark a lead whose system
        // asked for less motion sees. There is nothing for them to do and
        // nothing for anyone to fix in the moment.
        if (live) setPhase("still");
      },
    );
    // The hold. Only a mark still waiting for its first frame is moved on, so a
    // drawing already under way is never interrupted by it.
    const hold = setTimeout(() => {
      if (live) setPhase((p) => (p === "holding" ? "still" : p));
    }, CONFIRMATION_MARK.holdMs);
    return () => {
      live = false;
      clearTimeout(hold);
    };
  }, [playable]);

  const Player = player;
  const showStill = !playable || phase === "still" || phase === "ended";
  const showPlayer = playable && Player && phase !== "still";

  return (
    <div className="mx-auto flex max-w-72 items-center justify-center px-6 py-5">
      <div data-testid="confirmation-mark-box" className="relative h-36 w-36">
        {/* Mounted from the first render and HIDDEN until it is wanted, so it has
            loaded by the time the hold runs out rather than being requested
            then: that request was most of the blank Dan saw on 2026-09-29.
            Hidden rather than merely covered, because both layers are
            transparent and a coin behind the drawing shows through (#2560). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={CONFIRMATION_MARK.still}
          alt=""
          aria-hidden="true"
          width={CONFIRMATION_MARK.size}
          height={CONFIRMATION_MARK.size}
          className={`absolute inset-0 h-36 w-36 object-contain${showStill ? "" : " invisible"}`}
        />
        {showPlayer ? (
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
            <Player
              // `render` fires on every frame, and once more on the last one,
              // which can land AFTER `complete`. Advancing only out of
              // `holding` makes both harmless, and a frame after the hold ran
              // out finds `still` and changes nothing.
              onDrawing={() => setPhase((p) => (p === "holding" ? "drawing" : p))}
              onEnded={() => setPhase((p) => (p === "drawing" ? "ended" : p))}
              // Once ended the still is already up, so a late error has nothing
              // left to take away.
              onFailed={() => setPhase((p) => (p === "ended" ? p : "still"))}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
