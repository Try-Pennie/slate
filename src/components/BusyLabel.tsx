"use client";

import type { ReactNode } from "react";

import { BobbingDots } from "@/components/BobbingDots";

/**
 * A button's label while its work is running: the moving cue, then the words.
 *
 * **The spacing lives on this span, never on the button, and that is the whole
 * reason this exists** (#2636). Safari lays a `<button>`'s children out inside an
 * anonymous box of its own, and that box does not carry the button's `gap`
 * (WebKit's `RenderButton` builds it from `createAnonymousBlockWithStyle` and
 * copies flex-grow, a minimum size and centring margins onto it, nothing else).
 * So a cue placed straight into a button is spaced correctly in Chrome and sits
 * against its label in Safari: Dan's iPhone, 2026-09-24, showed the third dot
 * touching the "M" of "Moving your call…", while the gap BETWEEN the dots,
 * which is on an ordinary span, was fine. That span is the proof this works.
 *
 * Every button drawing the cue goes through here; `scripts/test-busy-label-only.ts`
 * fails a hand rolled `<BobbingDots tone="current" />` anywhere else.
 */
export function BusyLabel({ children }: { children: ReactNode }) {
  return (
    <span data-busy-label className="inline-flex items-center gap-2">
      <BobbingDots tone="current" />
      {children}
    </span>
  );
}
