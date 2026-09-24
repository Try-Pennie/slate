/**
 * The booker lifecycle the embed announces to its host page (#2658).
 *
 * Pennie's GA4 tagging spec (v2, 2026-09-24) instruments cal.com's booker as a
 * lifecycle, one GA4 event per stage, through the embed's
 * `Cal.ns.<ns>("on", { action, callback })` API. Slate's widget announces the
 * same lifecycle under cal.com's own event names and payload shapes, so the
 * host's one GTM listener needs no Slate branch.
 *
 * Two vocabularies, and the split is deliberate:
 *
 * - The RAW MESSAGE names (`slate:*`) are what the Booker posts from inside the
 *   iframe to `public/widget.js` on the host page. A host that frames `/book`
 *   itself (trypennie's inline iframe page does) listens for these directly.
 * - The WIDGET EVENT names are cal.com's, emitted by `widget.js` to `Cal("on")`
 *   listeners. They are not in this file because `widget.js` is a dependency
 *   free static asset that can import nothing; the mapping lives in its message
 *   listener, and `src/components/widget-embed.test.ts` drives the real file
 *   with the constants below, so the two sides cannot drift apart silently.
 *
 * Nothing here is copy a lead reads. The `msg` on a failed load is read by an
 * analyst in a GA4 report, in the host's own analytics, never on a screen.
 *
 * No message carries the lead's contact: a browser message is the wrong channel
 * for personal data, and the host already holds it. Booking id, times, status
 * and the test flag only.
 */

/** The messages the Booker posts to its parent. Every one goes through the
 *  Booker's `postToParent`, to the known parent origin only, never "*". */
export const EMBED_MESSAGE = {
  /** First render of the Booker in this frame load. */
  bookerViewed: "slate:bookerViewed",
  /** The availability answered with at least one time, once per frame load. */
  bookerReady: "slate:bookerReady",
  /** The booker could not be used: the availability read failed, or the page
   *  boundary caught a crash. */
  linkFailed: "slate:linkFailed",
  /** The in embed cancel of the call a recognised lead already had succeeded. */
  bookingCancelled: "slate:bookingCancelled",
  /** UNCHANGED since #593: a fresh booking or a moved call, keyed by `outcome`. */
  bookingSuccessful: "slate:bookingSuccessful",
} as const;

export type EmbedMessageType = (typeof EMBED_MESSAGE)[keyof typeof EMBED_MESSAGE];

/**
 * Why the booker could not be used, as the host's `linkFailed` sees it. The
 * code is stable and machine readable; the msg is one short human sentence, no
 * stack and no raw error text, because it lands in a GA4 parameter.
 */
export const LINK_FAILED = {
  availabilityFailed: {
    code: "availability_failed",
    msg: "Available times could not be loaded",
  },
  bookerCrashed: {
    code: "booker_crashed",
    msg: "The booking form stopped working",
  },
} as const;

export type LinkFailedDetail = (typeof LINK_FAILED)[keyof typeof LINK_FAILED];

/** The payload behind `slate:bookerViewed` and `slate:bookerReady`. */
export interface BookerViewedDetail {
  /** Whether at least one time was already loaded when the message was posted. */
  slotsLoaded: boolean;
}

/**
 * The payload behind `slate:bookingCancelled`, shaped as cal.com's
 * `bookingCancelled` carries it (`booking.uid`, `booking.cancellationReason`),
 * plus the call's bounds so a host can name what was given up.
 */
export interface BookingCancelledDetail {
  booking: {
    /** The booking id, or null when the cancel answered without one. */
    uid: string | null;
    /** ISO instant the cancelled call was due to start. */
    startTime: string;
    /** ISO instant it was due to end, or null when the cancel answered without one. */
    endTime: string | null;
    /** The reason CODE the lead chose (a vocabulary value, never free text). */
    cancellationReason: string;
  };
}
