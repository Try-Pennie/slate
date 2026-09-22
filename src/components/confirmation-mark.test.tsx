// @vitest-environment jsdom
//
// #2163 put the branded mark on the confirmation screen; #2560 changed what
// draws it, and this file is about the part that has to survive that change.
//
// The mark used to be an autoplaying `<video>`, and iOS refuses to autoplay one
// in Low Power Mode. Many iPhone owners leave Low Power Mode on permanently, so
// that was a standing share of leads seeing nothing happen on the one branded
// moment in the booker. A dotLottie player draws with JavaScript, which Low
// Power Mode cannot block.
//
// What is asserted here is everything about the swap that fails SILENTLY. A
// player that never arrives, one that arrives and cannot start, and one that
// mounts for somebody who asked their system for less motion all look fine in
// review and in any test that only checks the canvas is present. The still coin
// is what stands behind all three, so it is asserted before the player, with the
// player, and after the player has gone.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ConfirmationMark } from "@/components/ConfirmationMark";
import { CONFIRMATION_MARK } from "@/lib/booking/confirmation-mark";

/** What the real player was handed, so a test can drive its two outcomes. */
const stub = vi.hoisted(() => ({
  props: null as null | {
    onDrawing: () => void;
    onEnded: () => void;
    onFailed: () => void;
  },
  mounts: 0,
}));

// The player is behind a dynamic import so it stays out of the booker's first
// load, and this stands in for it. The EXPORT NAME is not taken on trust: the
// dynamic import in ConfirmationMark is typechecked, so `tsc` fails if this and
// the real module ever disagree about what is exported.
vi.mock("@/components/ConfirmationMarkPlayer", () => ({
  ConfirmationMarkPlayer: (props: {
    onDrawing: () => void;
    onEnded: () => void;
    onFailed: () => void;
  }) => {
    stub.props = props;
    stub.mounts += 1;
    return <canvas data-testid="mark-player" aria-hidden="true" />;
  },
}));

/** Answer `prefers-reduced-motion` the way a browser would. jsdom has no media
 *  query engine at all, so without this every query returns false and the
 *  reduced-motion branch is simply never reachable, which reads as a pass. */
function withReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: reduce && q.includes("prefers-reduced-motion"),
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function still(): HTMLImageElement | null {
  return document.querySelector(`img[src="${CONFIRMATION_MARK.still}"]`);
}

/** Let the dynamic import settle. It resolves on a microtask, so this is a tick
 *  of the queue rather than a wait on the clock: nothing here depends on how
 *  busy the machine is. */
async function playerArrives() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  stub.props = null;
  stub.mounts = 0;
  withReducedMotion(false);
});

describe("confirmation mark (#2163, #2560)", () => {
  it("shows the still coin before the player has arrived", () => {
    render(<ConfirmationMark />);

    // The first paint is the still ALONE: the player is a separate chunk that is
    // still being fetched, and a lead on a slow connection must not be looking
    // at an empty panel while that happens.
    expect(still()).not.toBeNull();
    expect(screen.queryByTestId("mark-player")).toBeNull();
  });

  it("keeps the still until the player has actually painted, so nothing flashes empty", async () => {
    render(<ConfirmationMark />);
    await playerArrives();

    // Mounted is not drawing. The player still has a wasm and 65 frames to
    // fetch, and hiding the still the moment the component appears would leave
    // an empty panel for exactly as long as that takes.
    expect(screen.getByTestId("mark-player")).not.toBeNull();
    expect(still()).not.toBeNull();
  });

  it("hides the still once the player is really drawing, because both layers are transparent", async () => {
    render(<ConfirmationMark />);
    await playerArrives();
    act(() => stub.props!.onDrawing());

    // THIS ASSERTION IS THE REVERSE OF THE ONE THIS FILE SHIPPED WITH, and the
    // reversal is the point (#2163 -> #2560). While the mark was an opaque
    // `<video>` on its own cream ground, a still underneath was invisible until
    // the video faded, so "always in the tree" cost nothing and bought every
    // fallback. #2560 made the animation a TRANSPARENT canvas and carried that
    // structure over, so the premise that made it free was gone: the still was
    // painted through the animation for the whole 2.167 seconds. Measured on the
    // shipping assets, the still's coin draws 101px wide and the animation's
    // draws 62px, so it never came close to covering it (L204).
    expect(screen.getByTestId("mark-player")).not.toBeNull();
    expect(still()).toBeNull();
  });

  it("brings the still back when the player dies after it has started drawing", async () => {
    render(<ConfirmationMark />);
    await playerArrives();
    act(() => stub.props!.onDrawing());
    expect(still()).toBeNull();

    // Only reachable now that the still is hidden while drawing: a render error
    // part way through used to land on a canvas with a coin already behind it.
    // With the still gone it would leave an empty panel, so the failure path has
    // to put it back rather than only unmounting the player.
    act(() => stub.props!.onFailed());
    expect(screen.queryByTestId("mark-player")).toBeNull();
    expect(still()).not.toBeNull();
  });

  it("gives way to the still coin when it ends, rather than resting on its own last frame", async () => {
    render(<ConfirmationMark />);
    await playerArrives();
    act(() => stub.props!.onDrawing());

    expect(screen.getByTestId("confirmation-mark-layer").className).toContain("opacity-100");

    // The animation resolves to a small pale flat tick, which is a weak thing to
    // leave on screen and is a DIFFERENT picture from the one a reduced motion
    // lead sees. Every lead ends up looking at the same mark.
    act(() => stub.props!.onEnded());
    const layer = screen.getByTestId("confirmation-mark-layer");
    expect(layer.className).toContain("opacity-0");
    // The fade is on a layer this component owns, because the player library
    // drops a `style` prop whenever a className is set, so a duration handed to
    // it would silently never apply.
    expect(layer.getAttribute("style")).toContain(`${CONFIRMATION_MARK.settleMs}ms`);
    expect(still()).not.toBeNull();
  });

  it("leaves the still, and nothing else, when the player cannot start", async () => {
    render(<ConfirmationMark />);
    await playerArrives();

    // A wasm that will not load, or an animation that will not fetch. The canvas
    // goes away entirely rather than sitting there transparent: an element that
    // will never draw is one more thing that can go wrong on top of the still.
    act(() => stub.props!.onFailed());
    expect(screen.queryByTestId("mark-player")).toBeNull();
    expect(still()).not.toBeNull();
  });

  it("never mounts the player for a lead who asked for less motion", async () => {
    withReducedMotion(true);
    render(<ConfirmationMark />);
    await playerArrives();

    // The CSS guard in globals.css reaches animation-duration and
    // transition-duration, and a canvas painting itself frame by frame is
    // neither, so this branch is the only thing standing between that lead and a
    // full speed animation. Not mounted at all, so the chunk is never fetched
    // either.
    expect(stub.mounts).toBe(0);
    expect(screen.queryByTestId("mark-player")).toBeNull();
    expect(still()).not.toBeNull();
  });

  it("is decorative in the accessibility tree, because the words carry the news", async () => {
    render(<ConfirmationMark />);
    await playerArrives();

    const marks = [still(), screen.getByTestId("confirmation-mark-layer")];
    for (const mark of marks) {
      // The heading, the recap and the live region already say a booking was
      // made. A described graphic here would make a screen reader say it twice,
      // and BOTH layers are in the tree at once, so both have to be silent.
      expect(mark!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("names one size for the still, so the embed's height does not jump as it loads", () => {
    render(<ConfirmationMark />);

    // The host sizes the iframe from the Booker's own resize message, so an
    // element that arrives with no intrinsic size and then gets one posts two
    // different heights and the frame visibly jumps.
    expect(still()!.getAttribute("width")).toBe(String(CONFIRMATION_MARK.size));
    expect(still()!.getAttribute("height")).toBe(String(CONFIRMATION_MARK.size));
  });
});
