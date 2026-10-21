/**
 * The prerender switch, as `GET /api/embed/config` reads it (#3706).
 *
 * The switch is `booking_settings.embed_prerender_enabled` (migration 0195), flipped on
 * the admin Embedding page with no deploy. When a host page calls the embed's
 * `prerender` command at page load, widget.js asks this one question and builds the
 * booker frame, hidden, only on a yes, so a lead's first click shows times that have
 * already loaded. Off, a prerender does nothing and the click builds, as it always did.
 *
 * WHICH WAY IT FAILS. Every failed or hung read answers OFF, never the last value read,
 * because off is how the embed has always run and a prerender is only a head start:
 * no lead is harmed by a booker that loads on the tap. A failed read is held for the
 * TTL like a good one, so an outage costs one failing call per isolate per TTL rather
 * than one per partner page view, and each failure goes to `onError`.
 *
 * It is asked on every partner page view that prerenders, so it goes through the shared
 * cached switch reader (`src/lib/cached-switch.ts`): one database read per isolate per
 * `EMBED_PRERENDER_TTL_MS`, cut at a short deadline, at most one in flight.
 *
 * No imports beyond that pure module, so the admin's client components may take the
 * constants from here without the database reaching the browser bundle.
 */

import { makeCachedSwitchReader, type SwitchTimer } from "@/lib/cached-switch";

/** How long one read of the switch stands in an isolate. */
export const EMBED_PRERENDER_TTL_MS = 15_000;

/**
 * How long a browser may keep the endpoint's answer (`Cache-Control: max-age`). Short,
 * because a flip should reach pages quickly; long enough that one lead moving between
 * pages does not ask on every one.
 */
export const EMBED_CONFIG_MAX_AGE_SECONDS = 15;

/** How long until a flip reaches every partner page: the isolate's cache, then the browser's. */
export const EMBED_PRERENDER_LANDS_SECONDS = Math.ceil(EMBED_PRERENDER_TTL_MS / 1000) + EMBED_CONFIG_MAX_AGE_SECONDS;

/**
 * How long the endpoint waits for the database before answering off. widget.js gives
 * the whole question two seconds, so the read must leave room for the network both ways.
 */
export const EMBED_PRERENDER_READ_DEADLINE_MS = 500;

export function makeEmbedPrerenderReader(deps: {
  read: () => Promise<boolean>;
  now: () => number;
  onError: (err: unknown) => void;
  timer?: SwitchTimer;
}): () => Promise<boolean> {
  const read = makeCachedSwitchReader({
    label: "embed prerender switch",
    read: deps.read,
    now: deps.now,
    onError: deps.onError,
    timer: deps.timer,
    ttlMs: EMBED_PRERENDER_TTL_MS,
    readDeadlineMs: EMBED_PRERENDER_READ_DEADLINE_MS,
    fallback: () => false,
    onFailure: { kind: "hold" },
  });
  // Only a read made here answers yes: a failed read's stand in, the last value or the
  // default, is off, per the module comment.
  return async () => {
    const reading = await read();
    return reading.source === "read" ? reading.on : false;
  };
}
