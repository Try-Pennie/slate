// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ImpersonationFrame } from "@/components/ImpersonationFrame";

// #2037: the one surface that says "every action you take now happens as someone
// else" has to look like nothing else in Slate.
//
// The treatment is settled (design rounds, 2026-09-07, recorded in DESIGN.md's
// Hazard Rule and docs/design/impersonation-marker.html): a hazard striped frame
// around the viewport whose TOP EDGE is a mustard strip carrying the sentence.
// These assert the requirements that record numbers, IM1 to IM7.

afterEach(cleanup);

const frame = () => document.querySelector("[data-impersonation-frame]") as HTMLElement;
const strip = () => document.querySelector("[data-impersonation-strip]") as HTMLElement;

function renderFrame(extra: Record<string, unknown> = {}) {
  return render(
    <ImpersonationFrame name="Ada Lovelace" role="agent" {...extra}>
      <button type="button">Stop viewing as them</button>
    </ImpersonationFrame>,
  );
}

describe("ImpersonationFrame (#2037)", () => {
  it("says who is being viewed as, and what that means", () => {
    renderFrame();
    const text = strip().textContent ?? "";
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("agent");
    expect(text).toContain("recorded as them");
  });

  // IM4: the sentence is TWO elements, so a line can break only between them.
  // Dan: "split it better. At the period." A single string re-wraps wherever the
  // width happens to run out, which put the break mid clause.
  it("carries the sentence as two elements, breaking only at the period", () => {
    renderFrame();
    const clauses = strip().querySelectorAll("[data-impersonation-clause]");
    expect(clauses.length).toBe(2);
    expect(clauses[0]!.textContent?.trim().endsWith(".")).toBe(true);
    expect(clauses[1]!.textContent).toContain("Anything you do here");
  });

  // IM7: sky stays the only colour that means "do this", so the way out must not
  // be a primary button competing with the page's own primary action.
  it("does not draw the way out as a primary button", () => {
    renderFrame();
    const exit = screen.getByRole("button", { name: /stop viewing/i });
    expect(exit.className).not.toMatch(/pn-btn--primary/);
  });

  // IM1: one marker, four edges, no separate bar above the header.
  it("draws the frame on all four edges and nothing else", () => {
    renderFrame();
    expect(frame()).toBeTruthy();
    const edges = frame().querySelectorAll("[data-impersonation-edge]");
    expect(edges.length).toBe(3); // left, right, bottom; the top edge IS the strip
    expect(strip()).toBeTruthy();
  });

  // IM6: the height varies with width, so nothing may hardcode it. The frame
  // publishes what it MEASURED and the page reads that.
  it("publishes the strip height it measured and flags the mode on the root", () => {
    renderFrame();
    expect(document.documentElement.dataset.impersonating).toBe("on");
    // jsdom reports every box as zero, so the VALUE cannot be asserted here; that
    // it is published at all, and cleared again, is what this can see.
    expect(document.documentElement.style.getPropertyValue("--impersonation-strip-h")).not.toBe("");
  });

  it("takes the mode and the measurement back off the root when it goes", () => {
    const { unmount } = renderFrame();
    unmount();
    expect(document.documentElement.dataset.impersonating).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--impersonation-strip-h")).toBe("");
  });

  it("falls back to the email when the person has no name recorded", () => {
    render(
      <ImpersonationFrame name={null} email="ada@trypennie.com" role="manager">
        <button type="button">Stop viewing as them</button>
      </ImpersonationFrame>,
    );
    expect(strip().textContent).toContain("ada@trypennie.com");
  });
});

