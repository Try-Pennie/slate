/**
 * What the booker is asked to open as, read from its address (#3718), shared by
 * `/book` and `/demo` so both ask for the inline card the same way.
 *
 *  - `layout=inline`: the compact card widget.js's inline embed asks for.
 *  - `piece=times|callMeNow` (with the card): one piece of it, placed on its own by
 *    the page (Geoff, 2026-10-15).
 *  - `slot=<instant>` / `day=<yyyy-mm-dd>` (the full booker only): the pop up a
 *    times piece opens, on the details step for a picked time or on a day for View
 *    more times.
 *  - `cmnPress=1` (the whole card only): the pop up a Call me now piece opens, which
 *    makes the request on arrival and shows its confirmation.
 *
 * Anything it cannot read is absent, never a guess. Pure, so
 * `scripts/test-inline-entry.ts` drives it without a page.
 */
import { DateTime } from "luxon";
import { INLINE_PIECES, type InlinePiece } from "./lifecycle-events.ts";

type SP = Record<string, string | string[] | undefined>;

export interface InlineEntry {
  layout: "inline" | undefined;
  piece: InlinePiece | null;
  initialSlot: string | null;
  initialDay: string | null;
  pressCallMeNow: boolean;
}

const first = (sp: SP, key: string): string | undefined => {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
};

export function readInlineEntry(sp: SP): InlineEntry {
  const layout = first(sp, "layout") === "inline" ? ("inline" as const) : undefined;
  const pieceParam = first(sp, "piece");
  const piece =
    layout && (INLINE_PIECES as readonly string[]).includes(pieceParam ?? "") ? (pieceParam as InlinePiece) : null;
  const slot = first(sp, "slot") ?? "";
  const initialSlot = !layout && slot.includes("T") && DateTime.fromISO(slot).isValid ? slot : null;
  const day = first(sp, "day") ?? "";
  const initialDay =
    !layout && /^\d{4}-\d{2}-\d{2}$/.test(day) && DateTime.fromISO(day).isValid ? day : null;
  const pressCallMeNow = layout === "inline" && piece === null && first(sp, "cmnPress") === "1";
  return { layout, piece, initialSlot, initialDay, pressCallMeNow };
}
