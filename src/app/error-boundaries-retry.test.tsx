// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { ErrorBoundary, type ErrorInfo } from "next/dist/client/components/error-boundary";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

// #3425 (L753): Try again on every error boundary must be wired to `retry`, never
// `reset`. Next hands a boundary both: `reset` only clears the boundary and draws
// the children again from the payload the browser already holds, so a read that
// failed on the server throws again and the button looks dead; `retry` asks the
// server for the page first (`router.refresh()`), then clears.
//
// The other suites pass the boundary a `retry` prop by hand and press it, and
// `scripts/test-error-boundary.ts` matches the source, so neither would notice a
// boundary reading the wrong prop or a Next upgrade renaming it again (16 already
// renamed `reset` to `retry` once). This mounts each boundary the way Next does,
// inside Next's OWN ErrorBoundary with the props it really supplies, and presses
// the button: the page recovers only if the server was asked again.
//
// Discovered by glob rather than listed, so a boundary added later is covered the
// day it is added (L96).
const BOUNDARIES = import.meta.glob<{ default: ComponentType<ErrorInfo> }>(
  ["/src/app/**/error.tsx", "/src/app/global-error.tsx"],
  { eager: true },
);

vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/errors/report-boundary", () => ({ reportBoundaryCatch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

/** The segment's content: it throws until the server has been asked again. */
const server = { failing: true };
function Segment() {
  if (server.failing) throw new Error("the server read failed");
  return <p>the page loaded</p>;
}

function mountInsideNextsBoundary(Boundary: ComponentType<ErrorInfo>, refresh: () => void) {
  const router = {
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  } as unknown as AppRouterInstance;
  return render(
    <AppRouterContext.Provider value={router}>
      <ErrorBoundary errorComponent={Boundary}>
        <Segment />
      </ErrorBoundary>
    </AppRouterContext.Provider>,
  );
}

beforeEach(() => {
  server.failing = true;
  // React reports every caught render error; the boundary catching it is the point.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the mount tells the two props apart (its control)", () => {
  // Without this, a mount where Next stopped re-throwing, or where reset also
  // refreshed, would pass every boundary below whatever it was wired to.
  function WiredToReset({ reset }: ErrorInfo) {
    return <button onClick={() => reset()}>Try again</button>;
  }
  function WiredToRetry({ retry }: ErrorInfo) {
    return <button onClick={() => retry()}>Try again</button>;
  }

  it("a boundary wired to reset stays on the failure screen and never asks the server", async () => {
    const refresh = vi.fn(() => {
      server.failing = false;
    });
    mountInsideNextsBoundary(WiredToReset, refresh);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText("the page loaded")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a boundary wired to retry recovers", async () => {
    const refresh = vi.fn(() => {
      server.failing = false;
    });
    mountInsideNextsBoundary(WiredToRetry, refresh);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText("the page loaded")).toBeTruthy());
  });
});

describe("every error boundary's Try again asks the server again (#3425)", () => {
  it("finds the boundaries", () => {
    expect(Object.keys(BOUNDARIES)).toContain("/src/app/global-error.tsx");
    expect(Object.keys(BOUNDARIES)).toContain("/src/app/admin/error.tsx");
    expect(Object.keys(BOUNDARIES).length).toBeGreaterThanOrEqual(6);
  });

  it.each(Object.entries(BOUNDARIES))("%s recovers when Try again is pressed", async (_path, mod) => {
    const refresh = vi.fn(() => {
      server.failing = false;
    });
    mountInsideNextsBoundary(mod.default, refresh);
    expect(screen.queryByText("the page loaded")).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));

    expect(refresh).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText("the page loaded")).toBeTruthy());
  });
});
