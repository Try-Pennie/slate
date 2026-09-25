// @vitest-environment jsdom
//
// #2769 (with #2766 and #2748): inside the widget's modal the box used to change
// size at every step. The picker was one height, the confirm step grew it (it kept
// the day strip above the form), the existing call panel and the confirmation
// shrank it, and a frame shorter than its floor showed the page body beneath the
// white card. Dan, 2026-09-25: "keep it a consistent size and just remove things
// as needed".
//
// jsdom cannot lay anything out, so these hold the DECISIONS that make the box one
// size rather than measuring it: the height the booker reports never goes down,
// the root fills the frame it is given, short screens centre inside it, the
// confirm step carries no day strip in the embed, and the corner the host's close
// control sits in is left empty by everything the booker draws there. The widget's
// half of each relationship is read from the real `public/widget.js`, because each
// side is correct alone and only the pair can be wrong.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Booker from "@/components/Booker";
import StandaloneBookerShell from "@/components/StandaloneBookerShell";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/booking/core";
import { bookerSlotIso } from "@/components/booker-test-slot";

const slotIso = bookerSlotIso(3);
const availability = {
  bucket: { code: "411" },
  orgName: "Pennie",
  eventType: { name: "Advisor Call", description: null, durationMin: 30 },
  slots: [slotIso],
};

const baseProps = {
  bucketCode: "411",
  salesforceId: null,
  attendee: { name: "Dana Lead", email: "dana@example.com", phone: "(203) 561-5295" },
  prefill: {},
  rescheduleReasons: RESCHEDULE_REASONS,
  cancelReasons: CANCEL_REASONS,
  horizonDays: 4,
};

type Reply = { status: number; body: unknown };
function fetchWith(bookingReply: Reply) {
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/availability")) {
      return { ok: true, status: 200, json: async () => availability } as Response;
    }
    return {
      ok: bookingReply.status < 300,
      status: bookingReply.status,
      json: async () => bookingReply.body,
    } as Response;
  }) as unknown as typeof fetch;
}
const CONFIRMED: Reply = { status: 200, body: { startsAt: slotIso, advisorName: "Sam Rivera" } };
const EXISTING: Reply = {
  status: 409,
  body: {
    existingCall: {
      disclose: true,
      startsAt: slotIso,
      advisorName: "Sam Rivera",
      manageToken: "tok",
      phone: "+12035615295",
      mayCancel: true,
    },
  },
};

const dayChip = () =>
  screen.findByRole("button", { name: /^(TODAY|MON|TUE|WED|THU|FRI|SAT|SUN)/ });

async function toConfirmStep() {
  await userEvent.click(await dayChip());
  await userEvent.click(await screen.findByRole("button", { name: /:\d{2}/ }));
  await screen.findByLabelText("First name");
}

async function submit() {
  await userEvent.click(screen.getByRole("button", { name: /confirm booking/i }));
}

const rootOf = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-theme]")!;

/** The one box under the band, and the screen's own content inside it. */
function screenParts(container: HTMLElement, inside: Element) {
  const root = rootOf(container);
  const box = Array.from(root.children).find((el) => el.contains(inside)) as HTMLElement;
  const content = Array.from(box.children).find((el) => el.contains(inside)) as HTMLElement;
  return { box, content };
}

/** The classes that make the box one size at two columns: fixed, and scrolling inside. */
function expectTheOneBox(box: HTMLElement) {
  expect(box.hasAttribute("data-embed-body")).toBe(true);
  expect(box.classList).toContain("@3xl:h-[624px]");
  expect(box.classList).toContain("@3xl:flex-none");
  expect(box.classList).toContain("overflow-y-auto");
  expect(box.classList).toContain("flex-col");
}

// The widget's close control and its focus ring, read from the shipped file.
const widgetSrc = readFileSync(resolve("public/widget.js"), "utf8");
function closeControlGeometry() {
  const css = /close\.style\.cssText\s*=\s*((?:\s*"[^"]*"\s*\+?)+);/.exec(widgetSrc)?.[1];
  if (!css) throw new Error("could not find the close control's cssText in widget.js");
  const text = css.replace(/"\s*\+\s*"/g, "").replace(/"/g, "");
  const px = (prop: string) => {
    const m = new RegExp(`(?:^|;)${prop}:(\\d+)px`).exec(text);
    if (!m) throw new Error(`close control carries no ${prop} in px: ${text}`);
    return Number(m[1]);
  };
  // The focused state is painted in one place (paintClose), for both themes.
  const focus = /function paintClose\(\) \{[\s\S]*?\n    \}/.exec(widgetSrc)?.[0] ?? "";
  const outlineWidth = Number(/outline = closeFocused \? "(\d+)px solid/.exec(focus)?.[1]);
  const outlineOffset = Number(/outlineOffset = closeFocused \? "(-?\d+)px"/.exec(focus)?.[1]);
  const glow = Number(/boxShadow = closeFocused \? "0 0 0 (\d+)px/.exec(focus)?.[1]);
  if (![outlineWidth, outlineOffset, glow].every(Number.isFinite)) {
    throw new Error("could not read the close control's focus ring from widget.js");
  }
  const signedPx = (prop: string) => {
    const m = new RegExp(`(?:^|;)${prop}:(-?\\d+)px`).exec(text);
    if (!m) throw new Error(`close control carries no ${prop} in px: ${text}`);
    return Number(m[1]);
  };
  const position = /(?:^|;)position:([a-z]+)/.exec(text)?.[1];
  // #2789: a sticky control sits where its flow puts it, so its distance from
  // the right edge is its margin; `right` would act only on a horizontal scroll
  // the modal never has.
  const right = position === "sticky" ? px("margin-right") : px("right");
  return {
    text,
    position,
    top: px("top"),
    right,
    width: px("width"),
    height: px("height"),
    outlineWidth,
    outlineOffset,
    glow,
    marginTop: () => signedPx("margin-top"),
    marginBottom: () => signedPx("margin-bottom"),
  };
}

/** Tailwind v4 spacing class to px (the default 0.25rem scale). */
function spacingPx(cls: string): number {
  const m = /^(?:pr|me|mr)-(\d+(?:\.\d+)?)$/.exec(cls);
  if (!m) throw new Error(`not a spacing class: ${cls}`);
  return Number(m[1]) * 4;
}

let heldScroll = 0;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-theme") ? heldScroll : 0;
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the modal keeps one size across every step (#2769)", () => {
  it("reports the tallest height it has drawn, never a shorter one", async () => {
    fetchWith(CONFIRMED);
    const post = vi.spyOn(window.parent, "postMessage");
    const reported = () =>
      post.mock.calls
        .map((c) => c[0] as { type?: string; height?: number })
        .filter((m) => m.type === "slate:resize")
        .map((m) => m.height as number);

    heldScroll = 600;
    render(<Booker {...baseProps} embedded parentOrigin="https://host.test" />);
    await dayChip();
    await waitFor(() => expect(reported()).toContain(600));

    // A taller step grows the box once...
    heldScroll = 720;
    await toConfirmStep();
    await waitFor(() => expect(reported().at(-1)).toBe(720));

    // ...and a shorter one after it never shrinks it back, the confirmation
    // included, which is the last screen a lead reads.
    heldScroll = 450;
    await submit();
    await screen.findByRole("heading", { level: 2 });
    await waitFor(() => expect(reported().length).toBeGreaterThan(2));
    const heights = reported();
    expect(heights.at(-1)).toBe(720);
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
    }
  });

  it("the standalone page is not held: it has no frame to hold", async () => {
    fetchWith(CONFIRMED);
    const post = vi.spyOn(window.parent, "postMessage");
    heldScroll = 600;
    render(<Booker {...baseProps} />);
    await dayChip();
    expect(post.mock.calls.some((c) => (c[0] as { type?: string })?.type === "slate:resize")).toBe(false);
  });

  it("fills the frame it is given, so a short step never shows the page beneath it", async () => {
    fetchWith(CONFIRMED);
    const { container } = render(<Booker {...baseProps} embedded />);
    await dayChip();
    const root = rootOf(container);
    expect(root.classList).toContain("min-h-screen");
    expect(root.classList).toContain("flex");
    expect(root.classList).toContain("flex-col");
  });

  it("drops the day strip on the confirm step, where the heading already states the day", async () => {
    fetchWith(CONFIRMED);
    render(<Booker {...baseProps} embedded />);
    await toConfirmStep();
    expect(screen.queryByRole("group", { name: "Available days" })).toBeNull();
    // The day and time are still stated, once, in the step's own line.
    expect(screen.getByTestId("chosen-time").textContent).toMatch(/\d{4}/);
    // And the strip comes back with the times when the lead goes back.
    await userEvent.click(screen.getByRole("button", { name: "Back to time selection" }));
    expect(await screen.findByRole("group", { name: "Available days" })).toBeTruthy();
  });

  it("the standalone page keeps its layout: the strip stays on its confirm step", async () => {
    fetchWith(CONFIRMED);
    render(<Booker {...baseProps} />);
    await toConfirmStep();
    expect(screen.getByRole("group", { name: "Available days" })).toBeTruthy();
  });

  it("centres the confirmation in the held box", async () => {
    fetchWith(CONFIRMED);
    const { container } = render(<Booker {...baseProps} embedded />);
    await toConfirmStep();
    await submit();
    const heading = await screen.findByRole("heading", { level: 2 });
    const { box, content } = screenParts(container, heading);
    expectTheOneBox(box);
    expect(content.classList).toContain("my-auto");
  });

  it("the picker and the confirm step are drawn in the same box", async () => {
    fetchWith(CONFIRMED);
    const { container } = render(<Booker {...baseProps} embedded />);
    const chip = await dayChip();
    expectTheOneBox(screenParts(container, chip).box);
    await toConfirmStep();
    expectTheOneBox(screenParts(container, screen.getByLabelText("First name")).box);
  });

  it("the standalone page draws no fixed box", async () => {
    fetchWith(CONFIRMED);
    const { container } = render(<Booker {...baseProps} />);
    await dayChip();
    expect(container.querySelector("[data-embed-body]")).toBeNull();
  });
});

describe("the existing call panel fills the same box (#2766)", () => {
  it("is centred in the held box, in the details column's width rather than a narrow one", async () => {
    fetchWith(EXISTING);
    const { container } = render(<Booker {...baseProps} embedded />);
    await toConfirmStep();
    await submit();
    const heading = await screen.findByRole("heading", { name: "You already have a call booked" });
    const { box, content: body } = screenParts(container, heading);
    expectTheOneBox(box);
    expect(body.classList).toContain("my-auto");
    // max-w-md (28rem) read as a half filled box inside the 896px modal.
    expect(body.classList).not.toContain("max-w-md");
    expect(body.classList).toContain("max-w-2xl");
    expect(body.classList).toContain("w-full");
  });
});

describe("the host's close control has its corner to itself (#2748, #2766)", () => {
  it("sits inside the box's padding, with a focus ring that stays inside the rounded corner", () => {
    const g = closeControlGeometry();
    expect(g.width).toBeGreaterThanOrEqual(44);
    expect(g.height).toBeGreaterThanOrEqual(44);
    // How far the ring reaches past the button: its outline plus the glow.
    const ringReach = g.outlineOffset + g.outlineWidth + g.glow;
    expect(Math.min(g.top, g.right)).toBeGreaterThan(ringReach);
    // The modal's 16px corner: the ring's own corner (the button is rounded
    // 12px) must sit inside the arc, measured along the diagonal.
    const BOX_RADIUS = 16;
    const BUTTON_RADIUS = 12;
    const ringCornerCentre = g.top + BUTTON_RADIUS; // top === right, asserted below
    expect(g.top).toBe(g.right);
    const ringCornerRadius = BUTTON_RADIUS + ringReach;
    const ringCornerPoint = ringCornerCentre - ringCornerRadius / Math.SQRT2;
    const distanceFromArcCentre = Math.SQRT2 * (BOX_RADIUS - ringCornerPoint);
    expect(distanceFromArcCentre).toBeLessThan(BOX_RADIUS);
  });

  it("the test band stops short of the close control, whose corner stays white", async () => {
    fetchWith(CONFIRMED);
    render(<Booker {...baseProps} embedded isTest />);
    await dayChip();
    const band = screen.getByTestId("test-mode-band");
    const g = closeControlGeometry();
    const reserve = Array.from(band.classList).find((c) => /^(me|mr)-\d/.test(c));
    expect(reserve).toBeDefined();
    // The band runs to the frame's edge, so it must stop before the control's
    // left edge plus the ring's reach.
    expect(spacingPx(reserve!)).toBeGreaterThanOrEqual(
      g.right + g.width + g.outlineOffset + g.outlineWidth + g.glow,
    );
  });

  it("the standalone band still runs the full width, since nothing sits over it there", async () => {
    fetchWith(CONFIRMED);
    render(<Booker {...baseProps} isTest />);
    await dayChip();
    const band = screen.getByTestId("test-mode-band");
    expect(Array.from(band.classList).some((c) => /^(me|mr)-\d/.test(c))).toBe(false);
  });

  it("the timezone and clock row leaves the control's corner empty", async () => {
    fetchWith(CONFIRMED);
    render(<Booker {...baseProps} embedded />);
    await dayChip();
    const twelve = screen.getByRole("button", { name: "12h" });
    const row = twelve.closest<HTMLElement>("[data-display-controls]")!;
    const column = row.parentElement!;
    const g = closeControlGeometry();
    const columnPad = spacingPx(Array.from(column.classList).find((c) => /^px-\d/.test(c))!.replace("px-", "pr-"));
    // Only at two columns, where the row is the first thing in the corner. Below
    // that the event panel sits above it and the row is nowhere near the control,
    // and the padding would push the clock toggle onto a line of its own.
    const rowPad = Array.from(row.classList).find((c) => /^@3xl:pr-\d/.test(c));
    expect(rowPad).toBeDefined();
    // The row's right end sits this far in from the frame's right edge.
    expect(columnPad + spacingPx(rowPad!.replace("@3xl:", ""))).toBeGreaterThanOrEqual(g.right + g.width);
    expect(Array.from(row.classList).some((c) => /^pr-\d/.test(c))).toBe(false);
    expect(within(row).getByRole("button", { name: "24h" })).toBeTruthy();
  });
});

describe("the close control stays on screen at every scroll position (#2789)", () => {
  // On a phone the modal is full screen and scrolls as one piece. A control
  // positioned absolutely inside that scrolling box scrolls away with the
  // booker, taking the only visible way out with it. jsdom cannot scroll, so
  // these hold the decisions that pin it: the modal is the scroller, and the
  // control is sticky to that scrollport (its own first child, asserted on the
  // real DOM below).
  it("the modal is the box that scrolls", () => {
    const css = /modal\.style\.cssText\s*=([\s\S]*?);\n/.exec(widgetSrc)?.[1] ?? "";
    const text = css
      .split("\n")
      .map((l) => l.replace(/^\s*\/\/.*$/, ""))
      .join("")
      .replace(/"\s*\+\s*"/g, "")
      .replace(/"/g, "");
    expect(text).toMatch(/(?:^|;)overflow:auto/);
    expect(text).toMatch(/(?:^|;)position:relative/);
  });

  it("is sticky, not absolute: an absolute control scrolls off with the content", () => {
    // Sticky rather than fixed: a fixed control is placed against the VIEWPORT,
    // which is the modal only on a phone. On a laptop the modal is a centred
    // card, and a fixed control would sit in the host page's corner outside it.
    expect(closeControlGeometry().position).toBe("sticky");
  });

  it("rests where it pins, so it does not jump when the lead starts to scroll", () => {
    const g = closeControlGeometry();
    expect(g.marginTop()).toBe(g.top);
  });

  it("takes no room in the flow, so the booker still starts at the modal's top edge", () => {
    const g = closeControlGeometry();
    expect(g.marginTop() + g.height + g.marginBottom()).toBe(0);
    // Right aligned by its margin, since a sticky box sits where its flow puts it.
    expect(g.text).toMatch(/(?:^|;)margin-left:auto/);
  });

  it("no host rule moves it back out of the flow on a phone", () => {
    const css = /style\.textContent\s*=([\s\S]*?);\n/.exec(widgetSrc)?.[1] ?? "";
    expect(css).toContain("slate-widget-modal");
    expect(css).not.toMatch(/button[^{]*\{[^}]*position/);
  });
});

describe("the frame has no strip beneath it (#2766)", () => {
  it("the iframe is a block, so no inline baseline gap shows under the booker", () => {
    const iframeCss = /iframe\.style\.cssText\s*=\s*"([^"]*)"/.exec(widgetSrc)?.[1] ?? "";
    expect(iframeCss).toMatch(/display:block/);
  });

  it("on a phone the frame is at least as tall as the full screen modal", () => {
    const phone = /@media \(max-width:640px\)\{([\s\S]*?)"\s*\+\s*"@media \(prefers-reduced-motion/.exec(widgetSrc)?.[1] ?? "";
    expect(phone.replace(/"\s*\+\s*"/g, "")).toMatch(/\.slate-widget-modal iframe\{min-height:100%!important\}/);
  });
});

describe("the close control reads on the booker behind it, in both themes (#2748)", () => {
  // The control sits over the BOOKER, not over the white chrome, so a graphite
  // glyph and a graphite focus ring vanish on the dark booker. Driven through the
  // real widget.js, opened by a link that asks for each theme.
  beforeAll(() => {
    delete (window as unknown as { Cal?: unknown }).Cal;
    new Function(widgetSrc)();
  });
  afterEach(() => {
    document
      .querySelectorAll<HTMLButtonElement>('.slate-widget-overlay:not([aria-hidden="true"]) button[aria-label="Close"]')
      .forEach((b) => b.click());
    document.body.innerHTML = "";
  });

  function focusedClose(link: string, { loaded = true } = {}) {
    const trigger = document.createElement("button");
    trigger.setAttribute("data-cal-link", link);
    trigger.setAttribute("data-cal-namespace", `theme-${link}-${loaded}`);
    document.body.appendChild(trigger);
    trigger.click();
    const shown = '.slate-widget-overlay:not([aria-hidden="true"])';
    if (loaded) document.querySelector(`${shown} iframe`)!.dispatchEvent(new Event("load"));
    const close = document.querySelector<HTMLButtonElement>(`${shown} button[aria-label="Close"]`)!;
    close.dispatchEvent(new FocusEvent("focus"));
    return close;
  }

  it("is the modal's own first child, so the modal is the scrollport it pins to (#2789)", () => {
    const close = focusedClose("router?xbc=411");
    const modal = close.closest<HTMLElement>(".slate-widget-modal")!;
    expect(close.parentElement).toBe(modal);
    expect(modal.firstElementChild).toBe(close);
    expect(close.style.position).toBe("sticky");
  });

  // #2789: once pinned, booker content scrolls UNDER the control, so it carries
  // the booker's own surface as a plate and the glyph never sits on text. At the
  // top the plate is the colour of the corner behind it, so it is not seen.
  const globalsCss = readFileSync(resolve("src/app/globals.css"), "utf8");
  const darkSurface = /--surface:\s*(rgb\([^)]*\));\s*\/\*\s*cards float/.exec(globalsCss)?.[1];
  const white = /--pennie-white:\s*(rgb\([^)]*\));/.exec(globalsCss)?.[1];
  const norm = (c: string | undefined) => (c ?? "").replace(/\s+/g, "");

  it("carries the light booker's surface as its plate, and the white chrome's while loading", () => {
    expect(white).toBeDefined();
    expect(norm(focusedClose("router?xbc=411").style.backgroundColor)).toBe(norm(white));
    const loading = focusedClose("router?xbc=411&theme=dark", { loaded: false });
    expect(norm(loading.style.backgroundColor)).toBe(norm(white));
  });

  it("carries the dark booker's surface as its plate once that booker shows", () => {
    expect(darkSurface).toBeDefined();
    expect(norm(focusedClose("router?xbc=411&theme=dark").style.backgroundColor)).toBe(norm(darkSurface));
  });

  it("while the frame loads it sits on the white chrome, so it keeps the graphite ink", () => {
    const close = focusedClose("router?xbc=411&theme=dark", { loaded: false });
    expect(close.style.outline).toMatch(/rgb\(52,\s*52,\s*52\)/);
  });

  it("on the dark booker: a light glyph and a sky ring, the D17 focus line on navy", () => {
    const close = focusedClose("router?xbc=411&theme=dark");
    expect(close.style.outline).toMatch(/rgb\(130,\s*208,\s*255\)/);
    expect(close.style.color).not.toMatch(/rgb\(52,\s*52,\s*52\)/);
    close.dispatchEvent(new FocusEvent("blur"));
    // At rest, the dark theme's muted text, never the light one's graphite grey.
    expect(close.style.color).toMatch(/rgb\(165,\s*162,\s*177\)/);
  });

  it("on the light booker: the graphite ring and glyph, unchanged", () => {
    const close = focusedClose("router?xbc=411");
    expect(close.style.outline).toMatch(/rgb\(52,\s*52,\s*52\)/);
    close.dispatchEvent(new FocusEvent("blur"));
    expect(close.style.color).toMatch(/rgb\(106,\s*106,\s*112\)/);
  });
});

describe("the document behind the embedded booker paints the booker's surface (#2766, L231)", () => {
  it("marks the embedded page, and the stylesheet paints that page in the surface token", () => {
    const { container } = render(
      <StandaloneBookerShell embedded theme="dark">
        <p>booker</p>
      </StandaloneBookerShell>,
    );
    expect(container.querySelector("main[data-embedded-booker]")).not.toBeNull();
    const css = readFileSync(resolve("src/app/globals.css"), "utf8");
    const rule =
      /html:has\(main\[data-embedded-booker\]\),\s*html:has\(main\[data-embedded-booker\]\) body\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    // The booker root's own paint (`bg-surface` in both palettes), so the two
    // are one colour by construction rather than by two values kept in step.
    expect(rule![1]).toMatch(/background:\s*var\(--surface\)/);
  });

  it("the standalone page is left alone: it keeps the page background around the card", () => {
    const { container } = render(
      <StandaloneBookerShell embedded={false} theme="light">
        <p>booker</p>
      </StandaloneBookerShell>,
    );
    expect(container.querySelector("main[data-embedded-booker]")).toBeNull();
  });
});
