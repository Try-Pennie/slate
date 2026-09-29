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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ConfirmationMark, preloadConfirmationMark } from "@/components/ConfirmationMark";
import { CONFIRMATION_MARK } from "@/lib/booking/confirmation-mark";

/** What the real player was handed, so a test can drive its two outcomes. */
const stub = vi.hoisted(() => ({
  props: null as null | {
    onDrawing: () => void;
    onEnded: () => void;
    onFailed: () => void;
  },
  mounts: 0,
  warms: 0,
  warm: null as null | (() => Promise<void>),
}));

// The player is behind a dynamic import so it stays out of the booker's first
// load, and this stands in for it. The EXPORT NAME is not taken on trust: the
// dynamic import in ConfirmationMark is typechecked, so `tsc` fails if this and
// the real module ever disagree about what is exported.
vi.mock("@/components/ConfirmationMarkPlayer", () => ({
  warmConfirmationMarkPlayer: () => {
    stub.warms += 1;
    return stub.warm ? stub.warm() : Promise.resolve();
  },
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

function stillElement(): HTMLImageElement | null {
  return document.querySelector(`img[src="${CONFIRMATION_MARK.still}"]`);
}

/** The still coin as a lead SEES it. It stays mounted, hidden, from the first
 *  render (so it has loaded by the time it is needed), so "in the DOM" is not
 *  the question; "visible" is. */
function still(): HTMLImageElement | null {
  const img = stillElement();
  return img && !img.className.split(/\s+/).includes("invisible") ? img : null;
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
  stub.warms = 0;
  stub.warm = null;
  withReducedMotion(false);
  // The hold is a real timer in the component, so the clock is SET here rather
  // than waited on: every test decides exactly when the hold runs out.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run the hold out without the player having painted. */
function holdRunsOut() {
  act(() => {
    vi.advanceTimersByTime(CONFIRMATION_MARK.holdMs);
  });
}

describe("confirmation mark (#2163, #2560, #2636)", () => {
  // Dan, on his phone in Low Power Mode, 2026-09-24: the coin showed, was
  // swapped for the tick drawing, then came back, and "it looked broken". The
  // still used to stand behind the LOADING state too, so a slow load put a
  // coin on screen, took it away for the drawing, and brought it back. The rule
  // now: a lead sees the drawing (settling on the coin) OR the coin, never
  // coin, drawing, coin.

  it("holds the spot empty while the animation loads, rather than showing a coin it will take away", async () => {
    render(<ConfirmationMark />);
    await playerArrives();

    expect(screen.getByTestId("mark-player")).not.toBeNull();
    expect(still()).toBeNull();
  });

  // Dan, 2026-09-29, rebooking: "it was just white for a second before the
  // coin showed up". Measured on a slowed phone profile, the still was only
  // REQUESTED when the hold ran out, so the blank lasted the hold plus a round
  // trip for the image (about 0.9s instead of 0.5s).
  it("has the still coin loading during the hold, hidden, so it appears the instant the hold runs out", async () => {
    render(<ConfirmationMark />);
    await playerArrives();

    const img = stillElement();
    expect(img).not.toBeNull();
    expect(img!.className).toContain("invisible");
    expect(still()).toBeNull();

    holdRunsOut();
    expect(stillElement()).toBe(img);
    expect(still()).not.toBeNull();
  });

  it("keeps the space reserved during the hold, so the screen does not jump when the mark arrives", () => {
    render(<ConfirmationMark />);

    const box = screen.getByTestId("confirmation-mark-box");
    expect(box.className).toContain("h-36");
    expect(box.className).toContain("w-36");
  });

  it("plays the drawing when it paints inside the hold, with no coin behind it", async () => {
    render(<ConfirmationMark />);
    await playerArrives();
    act(() => stub.props!.onDrawing());

    // Both layers are transparent (#2560), so a coin behind the drawing shows
    // through it; the drawing is on screen alone.
    expect(screen.getByTestId("mark-player")).not.toBeNull();
    expect(still()).toBeNull();

    // Painting in time means the hold running out changes nothing.
    holdRunsOut();
    expect(still()).toBeNull();
    expect(screen.getByTestId("mark-player")).not.toBeNull();
  });

  it("settles on the still coin when the drawing ends, rather than resting on its own last frame", async () => {
    render(<ConfirmationMark />);
    await playerArrives();
    act(() => stub.props!.onDrawing());
    expect(screen.getByTestId("confirmation-mark-layer").className).toContain("opacity-100");

    act(() => stub.props!.onEnded());
    const layer = screen.getByTestId("confirmation-mark-layer");
    expect(layer.className).toContain("opacity-0");
    // The fade is on a layer this component owns, because the player library
    // drops a `style` prop whenever a className is set.
    expect(layer.getAttribute("style")).toContain(`${CONFIRMATION_MARK.settleMs}ms`);
    expect(still()).not.toBeNull();
  });

  it("shows the still coin, and never the drawing, when the hold runs out first", async () => {
    render(<ConfirmationMark />);
    await playerArrives();
    const late = stub.props!;

    holdRunsOut();
    expect(still()).not.toBeNull();
    expect(screen.queryByTestId("mark-player")).toBeNull();

    // A first frame arriving after the coin is up must not take it away again:
    // that is exactly the coin, drawing, coin sequence Dan saw.
    act(() => late.onDrawing());
    expect(still()).not.toBeNull();
    expect(screen.queryByTestId("mark-player")).toBeNull();
  });

  it("shows the still coin straight away when the player cannot start, without waiting out the hold", async () => {
    render(<ConfirmationMark />);
    await playerArrives();

    act(() => stub.props!.onFailed());
    expect(screen.queryByTestId("mark-player")).toBeNull();
    expect(still()).not.toBeNull();
  });

  it("brings the still back when the player dies after it has started drawing", async () => {
    render(<ConfirmationMark />);
    await playerArrives();
    act(() => stub.props!.onDrawing());
    expect(still()).toBeNull();

    act(() => stub.props!.onFailed());
    expect(screen.queryByTestId("mark-player")).toBeNull();
    expect(still()).not.toBeNull();
  });

  it("shows the still coin at once, and never mounts the player, for a lead who asked for less motion", async () => {
    withReducedMotion(true);
    render(<ConfirmationMark />);
    await playerArrives();

    // The CSS guard in globals.css reaches animation-duration and
    // transition-duration, and a canvas painting itself frame by frame is
    // neither. No hold either: there is nothing to wait for.
    expect(stub.mounts).toBe(0);
    expect(screen.queryByTestId("mark-player")).toBeNull();
    expect(still()).not.toBeNull();
  });

  it("is decorative in the accessibility tree, because the words carry the news", async () => {
    render(<ConfirmationMark />);
    await playerArrives();
    act(() => stub.props!.onDrawing());
    act(() => stub.props!.onEnded());

    const marks = [still(), screen.getByTestId("confirmation-mark-layer")];
    for (const mark of marks) {
      expect(mark!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("names one size for the still, so the embed's height does not jump as it loads", () => {
    withReducedMotion(true);
    render(<ConfirmationMark />);

    expect(still()!.getAttribute("width")).toBe(String(CONFIRMATION_MARK.size));
    expect(still()!.getAttribute("height")).toBe(String(CONFIRMATION_MARK.size));
  });
});

describe("loading the animation early (#2636, and the blank of 2026-09-29)", () => {
  function captureImages() {
    const srcs: string[] = [];
    vi.stubGlobal(
      "Image",
      class {
        set src(v: string) {
          srcs.push(v);
        }
      },
    );
    return srcs;
  }

  // Warming only the HTTP cache was not enough: the files are served
  // `max-age=0, must-revalidate`, so the player still paid a round trip for each
  // and compiled its wasm on the confirmation screen, and on a slowed phone
  // profile it never painted inside the hold. The player warms ITSELF now.
  it("warms the player itself once, however often it is asked", async () => {
    captureImages();
    preloadConfirmationMark({ force: true });
    preloadConfirmationMark();
    await playerArrives();

    expect(stub.warms).toBe(1);
  });

  it("starts loading the still coin too, since it is what shows when the drawing is late", () => {
    const srcs = captureImages();
    preloadConfirmationMark({ force: true });

    expect(srcs).toEqual([CONFIRMATION_MARK.still]);
  });

  it("does not throw when warming fails, because the confirmation screen has its own fallback", async () => {
    captureImages();
    stub.warm = () => Promise.reject(new TypeError("offline"));

    expect(() => preloadConfirmationMark({ force: true })).not.toThrow();
    // Let the rejection settle: an unhandled one would fail the run.
    await playerArrives();
    expect(stub.warms).toBe(1);
  });

  it("tries again on the next call after a warm that failed, so one flaky moment does not cost the drawing for the whole visit", async () => {
    captureImages();
    stub.warm = () => Promise.reject(new TypeError("offline"));
    preloadConfirmationMark({ force: true });
    await playerArrives();

    stub.warm = null;
    preloadConfirmationMark();
    await playerArrives();
    expect(stub.warms).toBe(2);

    // And once one has succeeded, it is not repeated.
    preloadConfirmationMark();
    await playerArrives();
    expect(stub.warms).toBe(2);
  });

  it("warms nothing for a lead who asked for less motion, since they will only ever see the still", async () => {
    withReducedMotion(true);
    const srcs = captureImages();

    preloadConfirmationMark({ force: true });
    await playerArrives();
    expect(stub.warms).toBe(0);
    expect(srcs).toEqual([]);
  });
});
