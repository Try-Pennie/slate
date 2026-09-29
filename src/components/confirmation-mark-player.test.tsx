// @vitest-environment jsdom
//
// The player half of the confirmation mark warming itself (2026-09-29). Dan,
// rebooking a call: "it was just white for a second before the coin showed up".
// On a slowed phone profile the drawing never painted inside the 500ms hold even
// with the early load, because that load only warmed the HTTP cache: the files
// are served `max-age=0, must-revalidate`, so the player still paid a round trip
// for the animation and compiled its wasm on the confirmation screen itself.
//
// So the early load now compiles the wasm and holds the animation's bytes in
// memory, and the player is handed those bytes rather than a URL. What is
// asserted here is the part that fails silently: bytes that never arrive must
// leave the player on its URL, not on nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { CONFIRMATION_MARK } from "@/lib/booking/confirmation-mark";

const lib = vi.hoisted(() => ({
  preloads: 0,
  props: null as null | { src?: string; data?: ArrayBuffer },
}));

vi.mock("@lottiefiles/dotlottie-web", () => ({
  DotLottie: {
    preload: () => {
      lib.preloads += 1;
      return Promise.resolve();
    },
  },
}));

vi.mock("@lottiefiles/dotlottie-react", () => ({
  setWasmUrl: () => {},
  DotLottieReact: (props: { src?: string; data?: ArrayBuffer }) => {
    lib.props = props;
    return <canvas />;
  },
}));

const noop = () => {};

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  lib.preloads = 0;
  lib.props = null;
  // Module state (the held bytes) is per import, so each test gets a fresh one.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("confirmation mark player warming itself", () => {
  it("compiles the wasm and hands the player the animation bytes, not a URL to fetch again", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetchSpy = vi.fn().mockResolvedValue(new Response(bytes));
    vi.stubGlobal("fetch", fetchSpy);
    const { warmConfirmationMarkPlayer, ConfirmationMarkPlayer } = await import(
      "@/components/ConfirmationMarkPlayer"
    );

    await warmConfirmationMarkPlayer();
    render(<ConfirmationMarkPlayer onDrawing={noop} onEnded={noop} onFailed={noop} />);

    expect(lib.preloads).toBe(1);
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([CONFIRMATION_MARK.animation]);
    expect(lib.props!.data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(lib.props!.data!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(lib.props!.src).toBeUndefined();
  });

  it("warms once, however often it is asked", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]).buffer));
    vi.stubGlobal("fetch", fetchSpy);
    const { warmConfirmationMarkPlayer } = await import("@/components/ConfirmationMarkPlayer");

    await Promise.all([warmConfirmationMarkPlayer(), warmConfirmationMarkPlayer()]);
    await warmConfirmationMarkPlayer();

    expect(lib.preloads).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the player on its URL when the animation could not be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const { warmConfirmationMarkPlayer, ConfirmationMarkPlayer } = await import(
      "@/components/ConfirmationMarkPlayer"
    );

    await expect(warmConfirmationMarkPlayer()).rejects.toThrow("offline");
    render(<ConfirmationMarkPlayer onDrawing={noop} onEnded={noop} onFailed={noop} />);

    expect(lib.props!.src).toBe(CONFIRMATION_MARK.animation);
    expect(lib.props!.data).toBeUndefined();
  });

  it("leaves the player on its URL when the server refused the animation, rather than feeding it an error page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    const { warmConfirmationMarkPlayer, ConfirmationMarkPlayer } = await import(
      "@/components/ConfirmationMarkPlayer"
    );

    await expect(warmConfirmationMarkPlayer()).rejects.toThrow("503");
    render(<ConfirmationMarkPlayer onDrawing={noop} onEnded={noop} onFailed={noop} />);

    expect(lib.props!.src).toBe(CONFIRMATION_MARK.animation);
    expect(lib.props!.data).toBeUndefined();
  });

  it("asks again after a failed warm, so one flaky fetch does not cost every later try", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(new Response(new Uint8Array([9]).buffer));
    vi.stubGlobal("fetch", fetchSpy);
    const { warmConfirmationMarkPlayer } = await import("@/components/ConfirmationMarkPlayer");

    await expect(warmConfirmationMarkPlayer()).rejects.toThrow();
    await warmConfirmationMarkPlayer();
    await settle();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
