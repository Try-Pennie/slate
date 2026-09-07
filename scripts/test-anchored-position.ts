// Where a floating panel goes, decided as arithmetic (#1843).
//
// The roster's row menu was drawn `absolute` inside the table's
// `overflow-x-auto` wrapper, so the wrapper clipped it. The part that is not
// obvious, and that made this read as a horizontal-only setting causing a
// VERTICAL bug: CSS does not let one axis scroll while the other stays visible.
// Setting either axis to anything but `visible` computes the other to `auto`, so
// `overflow-x-auto` clips the bottom too, which is where the menus on the last
// rows of a 117 agent table fall.
//
// The escape is a portal plus `position: fixed`, which no ancestor can clip. That
// leaves the coordinates to be computed, and THIS is that computation: pure, so
// the flip and the clamp can be driven at sizes no jsdom test could produce,
// since jsdom has no layout and every rect it reports is zero.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs \
//        scripts/test-anchored-position.ts
import { assert, eq, finish } from "./lib/harness.ts";
import {
  anchoredPosition,
  triggerIsOnScreen,
} from "../src/components/ui/anchored-position.ts";

const trigger = (top: number, left = 500, w = 44, h = 44) => ({
  top,
  left,
  right: left + w,
  bottom: top + h,
  width: w,
  height: h,
});
const viewport = { width: 1440, height: 900 };
const panel = { width: 220, height: 120 };

// --- it hangs below the trigger when there is room ---------------------------
{
  const p = anchoredPosition({ trigger: trigger(100), panel, viewport, align: "end", gap: 4 });
  eq(p.placement, "below", "with room underneath it hangs below");
  eq(p.top, 148, "top is the trigger's bottom plus the gap");
  eq(p.left, 324, "aligned to the trigger's RIGHT edge, so it opens inward");
}

// --- it flips up when the panel would leave the viewport ---------------------
{
  // A trigger near the bottom: 820 + 44 + 4 + 120 = 988, past the 900 viewport.
  const p = anchoredPosition({ trigger: trigger(820), panel, viewport, align: "end", gap: 4 });
  eq(p.placement, "above", "with no room underneath it opens upward");
  eq(p.top, 696, "top is the trigger's top minus the panel and the gap");
  assert(p.top >= 0, "and it is still on screen");
}

// --- the flip is decided by ROOM, not by which half of the screen it is in ----
{
  // Same trigger position, a panel short enough to fit. The naive rule ("below
  // the halfway line, flip") would open this upward for no reason.
  const short = anchoredPosition({
    trigger: trigger(820), panel: { width: 220, height: 24 }, viewport, align: "end", gap: 4,
  });
  eq(short.placement, "below", "a short panel that fits stays below even near the bottom");
}

// --- when it fits NEITHER way, it takes the side with more room ---------------
{
  const tall = { width: 220, height: 800 };
  const low = anchoredPosition({ trigger: trigger(700), panel: tall, viewport, align: "end", gap: 4 });
  eq(low.placement, "above", "more room above than below, so above");
  eq(low.top, 0, "and it is clamped to the top rather than drawn off screen");
  const high = anchoredPosition({ trigger: trigger(60), panel: tall, viewport, align: "end", gap: 4 });
  eq(high.placement, "below", "more room below than above, so below");
  assert(high.top + tall.height >= viewport.height, "it overflows, which is why it scrolls");
}

// --- horizontal: it never hangs off either edge -------------------------------
{
  const right = anchoredPosition({ trigger: trigger(100, 1420, 20), panel, viewport, align: "end", gap: 4 });
  assert(right.left + panel.width <= viewport.width, "clamped away from the right edge");
  const left = anchoredPosition({ trigger: trigger(100, 4, 20), panel, viewport, align: "start", gap: 4 });
  eq(left.left, 4, "a start-aligned panel with room stays on the trigger's left edge");
  const offLeft = anchoredPosition({ trigger: trigger(100, 4, 20), panel, viewport, align: "end", gap: 4 });
  assert(offLeft.left >= 0, "and an end-aligned one near the left edge is clamped on screen");
}

// --- a panel wider than the viewport is pinned, not centred off screen --------
{
  const huge = anchoredPosition({
    trigger: trigger(100), panel: { width: 2000, height: 100 }, viewport, align: "end", gap: 4,
  });
  eq(huge.left, 0, "a panel wider than the window starts at the left edge");
}


// #2052: a page scroll REPOSITIONS an open panel rather than dismissing it, and
// only a trigger that has left the viewport closes it.
//
// This reverses the decision recorded at the top of AnchoredPanel ("it closes on
// scroll rather than following the trigger"). That reasoning was about a row
// menu on a long table, where a menu hovering beside an unrelated row really is
// worse than one that has gone. It was wrong for a picker somebody is filling
// IN: scrolling to see the field being edited, or an inertial flick on a
// trackpad, shut the calendar mid pick. Following the trigger serves both, and
// leaving the viewport is what the original concern actually reduces to.
//
// Pure, so the cases can be driven at sizes jsdom cannot produce, since jsdom
// reports every rect as zero.
{
  const view = { width: 1000, height: 800 };
  const box = (top: number, height = 40, left = 100, width = 200) => ({
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
  });

  assert(triggerIsOnScreen(box(400), view), "a trigger in the middle of the page is on screen");
  assert(triggerIsOnScreen(box(0), view), "one flush against the top edge is on screen");
  assert(
    triggerIsOnScreen(box(760), view),
    "one flush against the bottom edge is on screen",
  );

  // PARTIALLY visible counts, in both directions. Half a field is still a field
  // somebody is looking at, and closing its picker there is the complaint.
  assert(triggerIsOnScreen(box(-20), view), "one half above the top edge is still on screen");
  assert(
    triggerIsOnScreen(box(780), view),
    "one half below the bottom edge is still on screen",
  );

  // Gone entirely, in each of the four directions.
  assert(!triggerIsOnScreen(box(-40), view), "one scrolled entirely above is gone");
  assert(!triggerIsOnScreen(box(800), view), "one scrolled entirely below is gone");
  assert(
    !triggerIsOnScreen(box(400, 40, -200, 200), view),
    "one scrolled entirely off the left is gone",
  );
  assert(
    !triggerIsOnScreen(box(400, 40, 1000, 200), view),
    "one scrolled entirely off the right is gone",
  );

  // The exact boundaries, which decide whether a trigger touching the edge keeps
  // its panel. Touching by a single pixel counts as present; sharing only an edge
  // does not, because a zero height overlap is nothing to point at.
  assert(!triggerIsOnScreen(box(-40, 40), view), "sharing only the top edge is gone");
  assert(triggerIsOnScreen(box(-39, 40), view), "overlapping the top edge by 1px is present");
  assert(!triggerIsOnScreen(box(800, 40), view), "sharing only the bottom edge is gone");
  assert(triggerIsOnScreen(box(799, 40), view), "overlapping the bottom edge by 1px is present");
}

finish();
