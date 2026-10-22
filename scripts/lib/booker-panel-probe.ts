// The browser half of the floating panel check (#1869): open the booker's timezone
// list from the keyboard, in the real deployed booker, and read what a person would
// notice. The verdict is `panelFault` in embed-render-check.ts, pinned offline by
// scripts/test-embed-render-check.ts; this file only drives and measures.
//
// The timezone list is the probe because it is the one floating panel a lead can
// reach without signing in, and all four popups (the row menu, the account menu, the
// date picker and this list) share one component (`AnchoredPanel`, #1843), so one
// assertion here covers the defects they share: a panel that closes the frame it
// opens, opens with focus on the page body, or is painted over by other chrome.
// jsdom cannot see any of those (no layout, no scrolling, no focus gating), which is
// why this runs in a real browser on the deployed site.
//
// It only ever READS the booker: it opens the list, presses one arrow key, and
// shuts it with Escape, which commits nothing, so the zone the booker shows is the
// one it started with and no request leaves the page.
import type { FrameLocator } from "playwright";
import type { PanelObservation } from "./embed-render-check.ts";

/** The booker's timezone control (`Booker.tsx`, a SelectField). */
export const BOOKER_TZ = "#booker-tz";

/** How long the list gets to open, place itself and answer each key. Generous for a
 *  real deployment over the internet, still far inside the canary's budget. */
const PANEL_TIMEOUT_MS = 5_000;

/** How many times, and how long apart, the opening key is tried while the control
 *  may still be waiting to hydrate: up to fifteen seconds in all. */
const OPEN_ATTEMPTS = 15;
const OPEN_ATTEMPT_MS = 1_000;

/** What the frame reports about the open list, measured inside the frame. */
interface PanelMeasure {
  opened: boolean;
  onScreen: boolean;
  unobscured: boolean;
  focusInside: boolean;
  activeId: string | null;
  activeVisible: boolean;
}

/**
 * Measured in the frame's own document, against its own viewport. `el` is the
 * combobox trigger. Kept self contained: it is serialised into the page.
 */
function measure(el: Element): PanelMeasure {
  const listId = el.getAttribute("aria-controls");
  const list = listId ? document.getElementById(listId) : null;
  const opened = el.getAttribute("aria-expanded") === "true" && list !== null && !list.hidden;
  if (!list || !opened) {
    return { opened, onScreen: false, unobscured: false, focusInside: false, activeId: null, activeVisible: false };
  }
  const r = list.getBoundingClientRect();
  // One pixel of slack for subpixel placement, never more.
  const slack = 1;
  const onScreen =
    r.width > 0 &&
    r.height > 0 &&
    getComputedStyle(list).visibility === "visible" &&
    r.top >= -slack &&
    r.left >= -slack &&
    r.bottom <= window.innerHeight + slack &&
    r.right <= window.innerWidth + slack;
  const topmostIsList = (x: number, y: number) => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && list.contains(hit);
  };
  // Five points across the list, inset from its border, so a header covering only
  // its top edge or a footer covering its bottom is still caught.
  const inset = 6;
  const unobscured =
    onScreen &&
    [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
    ].every(([x, y]) => topmostIsList(x, y));
  const activeId = el.getAttribute("aria-activedescendant");
  const active = activeId ? document.getElementById(activeId) : null;
  const focused = document.activeElement === el || list.contains(document.activeElement);
  // A list opened on a value it does not hold has no highlighted row yet, which is
  // fine (the next arrow lands on the first row, and `walks` proves that); a
  // highlight pointing OUTSIDE the open list is not.
  const focusInside = focused && (activeId === null || (active !== null && list.contains(active)));
  let activeVisible = false;
  if (active && list.contains(active)) {
    const a = active.getBoundingClientRect();
    const cx = a.left + a.width / 2;
    const cy = a.top + a.height / 2;
    activeVisible = a.height > 0 && cy >= r.top && cy <= r.bottom && topmostIsList(cx, cy);
  }
  return { opened, onScreen, unobscured, focusInside, activeId, activeVisible };
}

/** After Escape: shut, and focus back on the control. */
function shutWithFocusHome(el: Element): boolean {
  const listId = el.getAttribute("aria-controls");
  const list = listId ? document.getElementById(listId) : null;
  const shut = el.getAttribute("aria-expanded") === "false" && (list === null || list.hidden);
  return shut && document.activeElement === el;
}

const notProbed: Omit<PanelObservation, "found" | "probeError"> = {
  opened: false,
  onScreen: false,
  unobscured: false,
  focusInside: false,
  walks: false,
  closesOnEscape: false,
};

/**
 * Open the booker's timezone list from the keyboard and read it. Never throws: a
 * driver fault comes back as `probeError`, which the judge fails on, so a probe that
 * broke can never read as a panel that works.
 */
export async function probeTimezonePanel(frame: FrameLocator): Promise<PanelObservation> {
  const trigger = frame.locator(BOOKER_TZ);
  try {
    if ((await trigger.count()) === 0) return { found: false, probeError: null, ...notProbed };
    // The control is drawn by the server before React hydrates it, and a key pressed
    // on it before hydration does nothing (measured against the deployment: the
    // first press, made the moment the chrome was visible, was lost). So the press
    // is repeated, only while the list is still shut, until it opens or the bound
    // runs out. A control that never answers the keyboard still fails, just after
    // the whole bound rather than one press.
    const expanded = frame.locator(`${BOOKER_TZ}[aria-expanded="true"]`);
    for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
      await trigger.focus({ timeout: PANEL_TIMEOUT_MS });
      await trigger.press("ArrowDown", { timeout: PANEL_TIMEOUT_MS });
      // Waited on the attribute itself rather than a fixed sleep (L290).
      const open = await expanded
        .waitFor({ state: "attached", timeout: OPEN_ATTEMPT_MS })
        .then(() => true)
        .catch(() => false);
      if (open) break;
    }
    const listId = await trigger.getAttribute("aria-controls", { timeout: PANEL_TIMEOUT_MS });
    if (listId) {
      await frame
        .locator(`[id="${listId}"]`)
        .waitFor({ state: "visible", timeout: PANEL_TIMEOUT_MS })
        .catch(() => {});
    }
    const first = await trigger.evaluate(measure);
    if (!first.opened) return { found: true, probeError: null, ...notProbed };

    await trigger.press("ArrowDown", { timeout: PANEL_TIMEOUT_MS });
    // The highlight moves on the next render; wait for the attribute to be PRESENT
    // and different. Present too, or a list opened with no highlight (no attribute
    // at all) would satisfy the wait at once, before the highlight had rendered.
    await frame
      .locator(`${BOOKER_TZ}[aria-activedescendant]:not([aria-activedescendant="${first.activeId ?? ""}"])`)
      .waitFor({ state: "attached", timeout: PANEL_TIMEOUT_MS })
      .catch(() => {});
    const second = await trigger.evaluate(measure);
    const walks =
      second.opened &&
      second.focusInside &&
      second.activeId !== null &&
      second.activeId !== first.activeId &&
      second.activeVisible;

    await trigger.press("Escape", { timeout: PANEL_TIMEOUT_MS });
    await frame
      .locator(`${BOOKER_TZ}[aria-expanded="false"]`)
      .waitFor({ state: "attached", timeout: PANEL_TIMEOUT_MS })
      .catch(() => {});
    const closesOnEscape = await trigger.evaluate(shutWithFocusHome);

    return {
      found: true,
      opened: true,
      onScreen: first.onScreen,
      unobscured: first.unobscured,
      focusInside: first.focusInside,
      walks,
      closesOnEscape,
      probeError: null,
    };
  } catch (err) {
    return { found: true, probeError: String(err).slice(0, 300), ...notProbed };
  }
}
