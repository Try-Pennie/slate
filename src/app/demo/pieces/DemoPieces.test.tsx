// @vitest-environment jsdom
//
// #3718: the demo pieces page stands in for one of Geoff's landing pages: it places
// the Call me now piece and the times piece separately, through the real widget.js,
// on the demo booker, so a press or a picked time opens the real pop up and reaches
// nobody. What this pins is what it asks widget.js for.
import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { DemoPieces } from "./DemoPieces";

type Call = unknown[];
function fakeCal() {
  const calls: Call[] = [];
  const nsCalls: Record<string, Call[]> = {};
  const cal = ((...args: unknown[]) => {
    calls.push(args);
    if (args[0] === "init" && typeof args[1] === "string") {
      const ns = args[1];
      nsCalls[ns] = [];
      cal.ns[ns] = (...a: unknown[]) => nsCalls[ns]!.push(a);
    }
  }) as ((...args: unknown[]) => void) & { ns: Record<string, (...a: unknown[]) => void> };
  cal.ns = {};
  (window as unknown as { Cal: unknown }).Cal = cal;
  return { calls, nsCalls };
}

afterEach(() => {
  delete (window as unknown as { Cal?: unknown }).Cal;
});

describe("the demo pieces page (#3718)", () => {
  it("places the Call me now piece and the times piece separately, on the demo booker", () => {
    const { calls, nsCalls } = fakeCal();
    const { container } = render(<DemoPieces theme="light" />);
    expect(calls[0]).toEqual(["init", "demo", { origin: window.location.origin }]);
    const inline = nsCalls.demo!.filter((c) => c[0] === "inline").map((c) => c[1] as Record<string, unknown>);
    expect(inline).toEqual([
      { elementOrSelector: "#demo-call-me-now", calLink: "demo?callMeNow=above", config: { piece: "callMeNow" } },
      { elementOrSelector: "#demo-times", calLink: "demo?callMeNow=above", config: { piece: "times" } },
    ]);
    expect(container.querySelector("#demo-call-me-now")).toBeTruthy();
    expect(container.querySelector("#demo-times")).toBeTruthy();
  });

  it("asks for the dark pieces when the page is dark", () => {
    const { nsCalls } = fakeCal();
    render(<DemoPieces theme="dark" />);
    expect(nsCalls.demo!.find((c) => c[0] === "ui")).toEqual(["ui", { theme: "dark" }]);
  });
});
