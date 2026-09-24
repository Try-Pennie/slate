"use client";

import { useSyncExternalStore } from "react";

import { deviceTimeZone } from "@/lib/booking/timezones";
import { formatViewerTime } from "@/lib/booking/viewer-time";

// The device's zone does not change under a page, so there is nothing to
// subscribe to; the store exists for its SERVER snapshot, below.
const subscribe = () => () => {};

/**
 * A booking time in the zone of the device reading it, labelled (#1916):
 * `Fri, Jul 3, 11:00am MST`.
 *
 * The ONE place a staff surface renders a booking time. Every surface used to
 * format on its own, in Eastern, with no zone on screen, because "the whole
 * roster is Eastern", which #1739 measured false. Dan's decision (2026-09-24) is
 * the viewer's zone, labelled, so every row on a screen shares one zone and says
 * which.
 *
 * WHY A CLIENT COMPONENT: most of these surfaces render on the server, which
 * cannot know who is reading, so the server passes the ISO instant and this
 * formats it on the device.
 *
 * HYDRATION: `useSyncExternalStore` renders with the SERVER snapshot (no zone,
 * so UTC, labelled UTC) during both the server render and hydration, so the two
 * markups match exactly and there is no mismatch to suppress. React then
 * re-renders with the device's zone straight after. A client-only render (a
 * search result fetched after mount) goes straight to the device's zone. What is
 * on screen before hydration is therefore a correct time with its zone named,
 * never an unlabelled one.
 */
export default function ViewerTime({ iso, seconds = false }: { iso: string; seconds?: boolean }) {
  const zone = useSyncExternalStore(subscribe, deviceTimeZone, () => "UTC");
  const text = formatViewerTime(iso, zone, { seconds });
  return <time dateTime={iso}>{text ?? "time unreadable"}</time>;
}
