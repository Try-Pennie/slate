// @vitest-environment jsdom
//
// #2729: inside the widget's modal the booker drew its PHONE layout on a desktop
// screen, because two facts set months apart never met. The booker went to two
// columns on a VIEWPORT breakpoint (`md:`, 768px), and inside an iframe the viewport
// is the frame, which the modal held at `min(720px, 92vw)`. A frame that can never
// be 768 wide can never show two columns, on every pilot page.
//
// So the booker now chooses its layout from the width of its OWN container, and the
// modal is as wide as the standalone booker's content. This file holds both halves
// against each other, because each is correct alone and only the pair was wrong.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import Booker from "@/components/Booker";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { bookerSlotIso } from "@/components/booker-test-slot";

// Tailwind v4's own scales, in px (1rem = 16px). The container scale is NOT the
// breakpoint scale (`@md` is 28rem, `md` is 48rem), which is why they are listed.
const CONTAINER_PX: Record<string, number> = {
  "@xl": 576, "@2xl": 672, "@3xl": 768, "@4xl": 896, "@5xl": 1024,
};
const MAX_W_PX: Record<string, number> = {
  "max-w-2xl": 672, "max-w-3xl": 768, "max-w-4xl": 896, "max-w-5xl": 1024,
};

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "", email: "", phone: "" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

async function renderBooker() {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      bucket: { code: "411" },
      orgName: "Pennie",
      eventType: { name: "Advisor Call", description: null, durationMin: 30 },
      slots: [bookerSlotIso(3)],
    }),
  })) as unknown as typeof fetch;
  const { container } = render(<Booker {...baseProps} embedded />);
  await screen.findByRole("heading", { name: "Advisor Call" });
  const root = container.querySelector<HTMLElement>("[data-theme]")!;
  const aside = root.querySelector<HTMLElement>("aside")!;
  const grid = aside.parentElement!;
  return { root, aside, grid };
}

/** The container variant a class list switches the two columns on, or null. */
function twoColumnVariant(grid: HTMLElement): string | null {
  const cls = Array.from(grid.classList).find((c) => /:grid-cols-\[260px_1fr\]$/.test(c));
  return cls ? cls.split(":")[0] : null;
}

/** The modal's widest desktop size, read from the real widget.js in this document. */
function modalCapPx(): number {
  const trigger = document.createElement("button");
  trigger.setAttribute("data-cal-link", "router?xbc=411");
  document.body.appendChild(trigger);
  trigger.click();
  const modal = document.querySelector<HTMLElement>(".slate-widget-modal")!;
  const css = modal.getAttribute("style") ?? "";
  const m = css.match(/width:\s*min\((\d+)px,\s*92vw\)/);
  if (!m) throw new Error(`modal width is not min(<px>, 92vw): ${css}`);
  return Number(m[1]);
}

beforeAll(() => {
  delete (window as unknown as { Cal?: unknown }).Cal;
  new Function(readFileSync(resolve("public/widget.js"), "utf8"))();
});

// Each test renders the whole Booker, and the first render in the file pays its
// cold start: 6.5s on a Mac runner busy with other jobs (main at 732b445,
// 2026-10-24), over vitest's 5s default. The bound is for that machine, not a
// budget the render is held to.
describe("the booker's layout follows its container, not the viewport (#2729)", { timeout: 20_000 }, () => {
  it("is a size container, so a variant on it measures the booker's own width", async () => {
    const { root } = await renderBooker();
    expect(root.classList).toContain("@container");
  });

  it("goes to two columns on a CONTAINER variant, with no viewport variant left", async () => {
    const { grid, aside } = await renderBooker();
    const variant = twoColumnVariant(grid);
    expect(variant).not.toBeNull();
    expect(variant!.startsWith("@")).toBe(true);
    expect(CONTAINER_PX[variant!]).toBeDefined();
    // The event panel's divider moves from under it to beside it on the SAME
    // switch, or there is a width where the columns and the rules disagree.
    expect(aside.classList).toContain(`${variant}:border-r`);
    expect(aside.classList).toContain(`${variant}:border-b-0`);
    for (const el of [grid, aside]) {
      expect(Array.from(el.classList).filter((c) => /^(sm|md|lg|xl|2xl):/.test(c))).toEqual([]);
    }
  });

  it("the desktop modal is the standalone booker's width, wide enough for two columns", async () => {
    const { root, grid } = await renderBooker();
    const shellWidth = Array.from(root.classList).find((c) => c in MAX_W_PX);
    expect(shellWidth).toBeDefined();
    const cap = modalCapPx();
    // The reference is the standalone page: the modal shows the booker at the
    // width it was designed at there, no wider and no narrower.
    expect(cap).toBe(MAX_W_PX[shellWidth!]);
    // And the relationship the bug broke: the widest frame reaches the switch.
    expect(cap).toBeGreaterThanOrEqual(CONTAINER_PX[twoColumnVariant(grid)!]);
  });

  it("the frame's floor is no taller than the two column booker", () => {
    // Measured in Chrome in the 896px modal on 2026-09-25: the shortest loaded
    // booker (a day not yet picked, no test band) is 447px. A floor above that
    // leaves a strip of empty page under the card, which is what 560 did once
    // the booker stopped stacking. jsdom cannot lay out, so the measurement is
    // written down here rather than taken.
    const SHORTEST_TWO_COLUMN_BOOKER_PX = 447;
    const iframe = document.querySelector<HTMLIFrameElement>(".slate-widget-modal iframe")
      ?? (modalCapPx(), document.querySelector<HTMLIFrameElement>(".slate-widget-modal iframe")!);
    const floor = Number(/min-height:\s*(\d+)px/.exec(iframe.getAttribute("style") ?? "")?.[1]);
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThanOrEqual(SHORTEST_TWO_COLUMN_BOOKER_PX);
  });
});
