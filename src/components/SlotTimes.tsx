"use client";

import type { ReactNode } from "react";

import { BobbingDots } from "@/components/BobbingDots";
import { PICKER_COPY, timesAvailableAnnouncement } from "@/lib/booking/booker-copy";
import { AlertIcon } from "@/components/icons";
import { formatSlotDay } from "@/lib/booking/slot-label";
import { messageLines, type SlotPickerView } from "@/lib/booking/slot-picker";
import { useStalledAfter } from "@/lib/useStalledAfter";

/**
 * How long a load may run before the working signal appears.
 *
 * Availability is served from a warm cache in roughly 40ms (#256), so showing
 * the dots the instant a load starts flashes them on and off on nearly every
 * load, which reads as a glitch rather than as progress. Under this, the strip's
 * placeholder chips carry the loading shape on their own and the times area
 * stays quiet, including for assistive tech: announcing a load and its result
 * back to back is noise, not information.
 */
const WORKING_SIGNAL_AFTER_MS = 250;

/**
 * The one times panel (#1336). The booker, the lead reschedule panel and the
 * admin reschedule panel each owned a private copy of "what to show while the
 * times load, when the load fails, and when the chosen day has nothing left",
 * and the copies had drifted. This owns those states; the surfaces supply their
 * own chrome through `classes` and `renderSlot`, so they look different while
 * behaving identically.
 *
 * The rule it holds: NO time renders until a day has been chosen. A bare clock
 * face carries no date, so offering times before the day is picked lets someone
 * choose 10:00 on a day they never looked at. `SlotPickerView` makes that
 * structural (the `pick-a-day` state has no slots to render).
 */

/** Theme-aware classes for the panel's own text and controls. */
export interface SlotTimesClasses {
  /** Muted body copy: the prompts and the empty messages. */
  muted: string;
  /** Strong copy: the `Times on <day>` heading. */
  heading: string;
  /** The Try again control. */
  retry: string;
  /** Wraps the rendered slots (a column on the booker, a grid on a panel). */
  grid: string;
}

/** Ready-made maps for the surfaces, so a new caller does not invent a fifth. */
export const SLOT_TIMES_CLASSES: Record<"light" | "panel", SlotTimesClasses> = {
  light: {
    muted: "text-sm text-fg-muted",
    heading: "text-sm font-semibold tabular-nums text-fg",
    retry:
      "inline-flex min-h-9 items-center rounded-md border border-border px-3 text-sm text-fg hover:border-fg/45",
    grid: "space-y-2",
  },
  panel: {
    muted: "text-sm text-fg-muted",
    heading: "text-sm font-semibold tabular-nums text-fg",
    retry:
      "inline-flex min-h-9 items-center rounded-md border border-border px-3 text-sm text-fg hover:border-fg/45",
    grid: "grid grid-cols-2 gap-2 sm:grid-cols-3",
  },
};

/** Each sentence on its own line, so the second never starts mid line (#1336). */
function PanelMessage({ text, className }: { text: string; className: string }) {
  return (
    <p className={className}>
      {messageLines(text).map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </p>
  );
}

// #1343: the words live in booker-copy.ts so `pnpm preview:booker` can render
// them without mounting React. The alias keeps this file's call sites unchanged.
const COPY = PICKER_COPY;

/** What assistive tech hears once a state settles (#633). A failure is read by
 *  its own role=alert, so the polite region stays quiet there. */
function announcement(
  view: SlotPickerView,
  dayLabel: (day: string) => string,
  working: boolean,
): string {
  switch (view.kind) {
    case "loading":
      return working ? COPY.loading : "";
    case "failed":
      return "";
    case "no-days":
      return "";
    case "pick-a-day":
      return COPY.pickADay;
    case "day-empty":
      return COPY.dayEmpty(dayLabel(view.day));
    case "outside-calling-hours":
      return COPY.outsideCallingHours(dayLabel(view.day));
    case "times":
      return timesAvailableAnnouncement(view.slots.length, dayLabel(view.day));
  }
}

export function SlotTimes({
  view,
  timeZone,
  onRetry,
  renderSlot,
  classes,
  noDaysNode,
}: {
  view: SlotPickerView;
  /** The viewer's zone: day headings and the announcement are read in it. */
  timeZone: string;
  onRetry: () => void;
  /** The surface's own slot button, so the chrome stays per-surface. */
  renderSlot: (iso: string) => ReactNode;
  classes: SlotTimesClasses;
  /** The fully empty message, which differs per surface (see #1328/#1339). */
  noDaysNode: ReactNode;
}) {
  // A day is a bare YYYY-MM-DD keyed in `timeZone`. Reading it back at noon UTC
  // keeps the label on that calendar day for every zone, east or west.
  const dayLabel = (day: string) => formatSlotDay(`${day}T12:00:00.000Z`, timeZone);
  const working = useStalledAfter(view.kind === "loading", WORKING_SIGNAL_AFTER_MS);

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement(view, dayLabel, working)}
      </span>
      {view.kind === "loading" ? (
        // The height is reserved either way, so the dots arriving after the grace
        // period does not shove the panel (or, in the embed, re-post a height).
        <div className="flex min-h-[92px] flex-col items-center justify-center gap-3 py-6">
          {working && (
            <>
              <BobbingDots />
              <p className={classes.muted}>{COPY.loading}</p>
            </>
          )}
        </div>
      ) : view.kind === "failed" ? (
        <div className="space-y-2">
          <p role="alert" className="flex items-start gap-2 text-sm text-[var(--error)]">
            <span className="mt-0.5 shrink-0">
              <AlertIcon width={15} height={15} />
            </span>
            <span>
              {messageLines(COPY.failed).map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </span>
          </p>
          <button type="button" onClick={onRetry} className={classes.retry}>
            Try again
          </button>
        </div>
      ) : view.kind === "no-days" ? (
        <>{noDaysNode}</>
      ) : view.kind === "pick-a-day" ? (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <PanelMessage text={COPY.pickADay} className={classes.muted} />
        </div>
      ) : view.kind === "day-empty" ? (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <PanelMessage text={COPY.dayEmpty(dayLabel(view.day))} className={classes.muted} />
        </div>
      ) : view.kind === "outside-calling-hours" ? (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <PanelMessage
            text={COPY.outsideCallingHours(dayLabel(view.day))}
            className={classes.muted}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {/* Extra room above the heading at desktop width only; mobile spacing
              is already right, so this is not a change to the base value. */}
          <p className={`${classes.heading} md:mt-1`}>Times on {dayLabel(view.day)}</p>
          <div className={classes.grid}>{view.slots.map((iso) => renderSlot(iso))}</div>
        </div>
      )}
    </>
  );
}
