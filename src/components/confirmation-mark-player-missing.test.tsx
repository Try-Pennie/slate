// @vitest-environment jsdom
//
// The one case that needs its own file (#2560): the player's CHUNK never
// arrives.
//
// This is a real state, not a hypothetical. The player and the animation are a
// separate chunk fetched when the confirmation step appears, so a deploy that
// has just rotated the hashed filenames, a dropped connection on a phone, or a
// blocked request all end the same way: the dynamic import REJECTS. A rejected
// import that nothing catches is an unhandled rejection, and in a component that
// renders its result it is an empty panel where the branded mark should be, on
// the last screen a lead sees.
//
// It is a separate file because the failure has to happen at MODULE LOAD, and a
// module registry is per file: a factory that throws cannot be un-thrown for a
// later test in the same file.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { ConfirmationMark } from "@/components/ConfirmationMark";
import { CONFIRMATION_MARK } from "@/lib/booking/confirmation-mark";

vi.mock("@/components/ConfirmationMarkPlayer", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

describe("confirmation mark with no player chunk (#2560)", () => {
  it("leaves the still coin, and nothing else", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    render(<ConfirmationMark />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const still = document.querySelector(`img[src="${CONFIRMATION_MARK.still}"]`);
    expect(still).not.toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
    // A rejection nobody handles would take the page's error reporting with it
    // on a screen that is otherwise working perfectly.
    expect(unhandled).not.toHaveBeenCalled();

    process.off("unhandledRejection", unhandled);
  });
});
