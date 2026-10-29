/**
 * What a settings form on an admin page says when it saves (#1990).
 *
 * ## The defect this exists to remove
 *
 * The confirmation travels as `?ok=` on a redirect and is drawn by
 * `SettingsSaveNotice`. That worked while a page held ONE form. Several of them
 * hold three or four, and the flag carried no name, so whichever form redirected
 * lit whatever sentence the page had hardcoded:
 *
 *   /admin/business-hours   saving the booking horizon (now the Days offered
 *                           card, #3922) printed "Hours saved.",
 *                           naming the hours week, which it had not touched
 *   /admin/buckets          changing the direct booking fallback confirmed,
 *                           creating or editing an actual pool did not
 *
 * The horizon one was wrong in the worse direction: not silence, but a sentence
 * naming a thing it had not done. And silence on such a page is worse than on a
 * page with no notice at all, because the page has already shown somebody that
 * it confirms saves, so the next silence reads as a failure rather than as a
 * feature nobody built.
 *
 * Not every form here uses this mechanism, and that is deliberate rather than an
 * omission. The business hours week and its date exceptions return their result
 * through `useActionState` and draw it inside their own form, which is a better
 * answer where the form is already a client component: the confirmation appears
 * where the person is looking. #1990 reported those two as silent; they are not,
 * and they are left alone.
 *
 * ## The shape
 *
 * The outcome carries the NAME of the form that saved. One vocabulary, here, so
 * an action and the page that renders its result cannot disagree about the
 * spelling: `tsc` names a key that does not exist, and the guard
 * (`scripts/test-save-outcomes.ts`) names a key nothing renders.
 *
 * A page still chooses its own WORDS, because it always did and because one of
 * them is built per render rather than fixed.
 */

import { FRAME_LOCK_TTL_SECONDS } from "@/lib/embed/frame-lock";
import { EMBED_PRERENDER_LANDS_SECONDS } from "@/lib/embed/prerender-switch-core";
import { SHARED_LINE_SWITCH_TTL_SECONDS } from "@/lib/booking/shared-line-switch-core";
import { DAYS_OFFERED_SAVED } from "@/lib/admin/days-offered-copy";
import { GOOGLE_RELINK_SAVED } from "@/lib/auth/google-identity-copy";

/**
 * Every outcome a form can report.
 *
 * Named for the FORM rather than the page, because two forms on one page is the
 * whole reason this is a name and not a flag.
 */
export const SAVE_OUTCOMES = [
  "agent-attributes",
  "agent-google-relinked",
  "agent-ooo-calendar",
  "alerts",
  "booker-copy",
  "booking-paused",
  "booking-reasons",
  "booking-resumed",
  "calcom-live",
  "calcom-retired",
  "coordinator-removed",
  "bucket-created",
  "bucket-routing",
  "bucket-updated",
  "days-offered",
  "event-type-created",
  "event-type-gap",
  "event-type-notice",
  "frame-locked",
  "frame-unlocked",
  "nearly-full",
  "org-default-hours",
  "placeholder-off",
  "placeholder-on",
  "transfer-offer",
  "prerender-off",
  "prerender-on",
  "regal-ignore-added",
  "regal-ignore-removed",
  "reminder-email-created",
  "reminder-email-off",
  "reminder-email-on",
  "reminder-email-restored",
  "reminder-email-saved",
  "shared-line-off",
  "shared-line-on",
  "volume-ramp-end-cleared",
  "volume-ramp-end-set",
  "webhook-endpoint",
  "working-hours",
] as const;

export type SaveOutcome = (typeof SAVE_OUTCOMES)[number];

/**
 * The sentence for each outcome whose wording is fixed.
 *
 * Every sentence names what was saved, never just that something was. A word
 * that appears whatever you pressed barely improves on silence, and on a page
 * with four forms it is actively misleading.
 */
export const SAVE_OUTCOME_COPY: Record<Exclude<SaveOutcome, DynamicOutcome>, string> = {
  "agent-attributes": "Routing attributes saved.",
  // #3526: names what now happens, because the one thing the admin needs confirmed
  // is that the next sign in with that address will be let through.
  "agent-google-relinked": GOOGLE_RELINK_SAVED,
  "agent-ooo-calendar": "Time off calendar saved.",
  alerts: "Alert settings saved.",
  "booker-copy": "Booker copy saved.",
  // #2297: the two directions of the kill switch get two sentences, because the
  // one thing a reader needs confirmed is WHICH WAY it went, and a shared
  // "Booking switch saved." would be the word that appears whatever you pressed.
  "booking-paused": "Online booking is stopped. Leads cannot book a call until you start it again.",
  "booking-reasons": "Booking reasons saved.",
  "booking-resumed": "Online booking is running again. Leads can book a call.",
  // #2875: each says which way it went and when it takes hold, because both
  // directions change what Slate writes. What each state MEANS is drawn once, by
  // the switch beneath this notice, so it is not said here a second time (L605).
  "calcom-retired": "Saved: cal.com is retired. Every cal.com lane stops at its next check, within 5 minutes.",
  // #4264: what Remove did, on the page it was pressed on (L608). Who it was is not
  // repeated: their row has just gone from the list beneath this notice.
  "coordinator-removed": "Removed. They can no longer sign in to Slate or book calls, and the calls they booked stay as they are.",
  "bucket-created": "Bucket created.",
  "bucket-routing": "Bucket routing saved.",
  "bucket-updated": "Bucket saved.",
  // #3922: the card's own name, the one its button and its refusals use.
  "days-offered": DAYS_OFFERED_SAVED,
  "event-type-created": "Event type created.",
  "event-type-gap": "Gap between calls saved. The booker offers times with the new gap within a minute or two.",
  "event-type-notice": "Notice saved. The booker offers times with the new notice within a minute or two.",
  // #3137: which way it went and when it lands, like the booking switch above.
  "frame-locked": `Framing is locked. Within ${FRAME_LOCK_TTL_SECONDS} seconds, only the sites on the allow list can show the booker.`,
  "frame-unlocked": `Framing is unlocked. Within ${FRAME_LOCK_TTL_SECONDS} seconds, any site can show the booker again.`,
  // #3936: the line's own name, the one the sentence on the page uses.
  "nearly-full": "Nearly full line saved.",
  "org-default-hours": "Default hours for a new agent saved.",
  // #4264: which way the coordinators' switch went. It is read on every booking, so it
  // lands from the next one. What each state means is drawn by the switch itself (L605).
  "placeholder-on": "Saved. From the next booking, a coordinator can put a call nobody is free for on Marcia.",
  "placeholder-off": "Saved. From the next booking, a coordinator who tries to book a call nobody is free for is refused.",
  // #4380: read on every transfer check, so it lands from the next customer found.
  "transfer-offer": "Live transfer saved. It applies from the next customer a coordinator finds.",
  // #3706: which way it went and when it lands, like the frame lock above. What each
  // state means for a lead is drawn once, by the switch beneath this notice (L605).
  "prerender-on": `Saved. Within ${EMBED_PRERENDER_LANDS_SECONDS} seconds, partner pages that ask will load the booker with the page.`,
  "prerender-off": `Saved. Within ${EMBED_PRERENDER_LANDS_SECONDS} seconds, partner pages load the booker on the tap again.`,
  // #2090. Each names what now happens, because the one thing the reader needs
  // confirmed is which way the list moved.
  "regal-ignore-added": "Added to the ignore list. Their calls in Regal are no longer reported.",
  "regal-ignore-removed": "Removed from the ignore list. Their calls in Regal are reported again.",
  // #4299: which way it went and who it reaches, since on and off are the saves a
  // lead feels. The email's own name is on the editor beneath this notice (L605).
  "reminder-email-created": "Reminder email added. It stays off until you switch it on.",
  "reminder-email-off": "Reminder email saved and switched off. No lead gets it until it is switched back on.",
  "reminder-email-on":
    "Reminder email saved and on. Calls already inside its window when you saved are skipped, and every later one gets it.",
  "reminder-email-restored": "Earlier copy restored. Its timing and whether it is on are unchanged.",
  "reminder-email-saved": "Reminder email saved.",
  // #3325: which way it went and when it lands, like the frame lock above. What each
  // state means is drawn once, by the switch beneath this notice (L605).
  "shared-line-on": `The shared confirm line is on. It takes hold on every server within ${SHARED_LINE_SWITCH_TTL_SECONDS} seconds.`,
  "shared-line-off": `The shared confirm line is off. Each server goes back to its own line within ${SHARED_LINE_SWITCH_TTL_SECONDS} seconds.`,
  // #2739. Each names what now happens to the floors, because which way it went is
  // the one thing the reader needs confirmed.
  "volume-ramp-end-set": "Ramp end saved. Slate learns its low volume floors from its own bookings after that day.",
  "volume-ramp-end-cleared": "Ramp end cleared. The low volume floors are the cal.com measurement again.",
  // #2384: the endpoint save used to revalidate the Overview and say nothing at
  // all, so a successful save and a refused one drew the same screen: the form
  // redrawn with whatever was stored before the press.
  "webhook-endpoint": "Webhook endpoint saved.",
  // #1997: "Hours saved." and nothing more. It used to recite the whole week,
  // which put the week on screen three times at once: here, in the summary
  // paragraph directly beneath, and in the day rows that hold every one of those
  // times in fields. The rows ARE the stored week on this render, because the
  // save redirects and they are drawn from the stored rules, so naming it again
  // in a banner told nobody anything the screen was not already saying.
  "working-hours": "Hours saved.",
};

/**
 * The outcomes whose sentence is built by the PAGE, per render, and why.
 *
 * Declared rather than left as an absence from the copy map, so a key that
 * simply has no sentence anywhere fails the build instead of confirming a save
 * in silence, which is the defect this module exists to remove.
 */
export const DYNAMIC_OUTCOME_REASONS = {
  // #2890: putting cal.com back names how many approved time off requests made
  // during retirement are waiting to be copied into it. The action measures that
  // count and carries it on the redirect, so the sentence is built per render by
  // `putBackSavedSentence` (src/lib/calcom/put-back.ts).
  //
  // (#1997: `working-hours` was once the only entry and left, which is why the map
  // sat empty for a while. It was kept because the guard is what makes it safe: an
  // outcome in NEITHER this map nor the fixed copy above fails the build rather
  // than confirming a save in silence.)
  "calcom-live": "names the count of time off waiting to be copied into cal.com, measured at the press",
} as const satisfies Partial<Record<SaveOutcome, string>>;

export type DynamicOutcome = keyof typeof DYNAMIC_OUTCOME_REASONS;

/**
 * The outcome a `?ok=` value names, or `null`.
 *
 * A value it does not recognise is `null` rather than a default, and that is the
 * point rather than tidiness: the flag used to be `ok=1`, so a bookmarked or
 * pasted link from before this change still carries it. Resolving that to any
 * sentence would print a confirmation for a save nobody performed, on a page
 * that had just been opened. Showing nothing is the honest answer (L11).
 */
export function savedOutcome(raw: string | undefined | null): SaveOutcome | null {
  if (!raw) return null;
  return (SAVE_OUTCOMES as readonly string[]).includes(raw) ? (raw as SaveOutcome) : null;
}

/** The sentence for an outcome whose wording is fixed, or `null` when the page
 *  builds its own. Never a default: a missing sentence is a build failure, not a
 *  quiet fallback. */
export function savedSentence(outcome: SaveOutcome | null): string | null {
  if (!outcome) return null;
  if (outcome in DYNAMIC_OUTCOME_REASONS) return null;
  return SAVE_OUTCOME_COPY[outcome as Exclude<SaveOutcome, DynamicOutcome>];
}

/** The query string a saving action redirects with. One builder, so no call site
 *  hand writes the parameter name. */
export function savedQuery(outcome: SaveOutcome): string {
  return `?ok=${outcome}`;
}

/**
 * The query string a REFUSED action redirects with, and the twin of
 * `savedQuery` (#2385).
 *
 * A refusal is a sentence about the REQUEST, something the reader submitted and
 * can change, so it travels back to the page they submitted from and is drawn
 * there. A FAULT is a sentence about the SYSTEM, a write Postgres refused or a
 * row that did not come back, which no retyping fixes: that still throws, the
 * boundary truthfully says the state is unknown, and the detail goes to the log.
 *
 * Fifteen sites used to build this string by hand. One builder, because the
 * parameter name is half of a contract with every page that renders it, and a
 * second spelling is a refusal that arrives nowhere while every part reads as
 * wired up (L41).
 *
 * The reason travels as free text rather than as a code, unlike the outcomes
 * above, and the difference is deliberate: a save confirms one of a closed set of
 * things, while a refusal has to name the value that was rejected, which no
 * closed set can hold. It is encoded here so no call site can forget, and the
 * pages render it as text, never as markup.
 */
export function refusedQuery(reason: string): string {
  return `?error=${encodeURIComponent(reason)}`;
}

/**
 * Every query parameter an outcome travels in, so the notice can strip them all
 * from the address bar once it has been read.
 *
 * One list, because a parameter left behind re-shows a stale notice on a reload
 * or a copied link, and the webhooks page's own two were invisible to the
 * stripper that only knew about `ok` and `error`.
 */
// `copy` and `remove` are the counts putting cal.com back carries (#2890); left in
// the address bar they would replay a stale count under a Saved banner.
export const OUTCOME_PARAMS = ["ok", "error", "resend", "replay", "form", "copy", "remove"] as const;

/**
 * The `form` a refusal names when its page draws that form's refusal beside the
 * form rather than at the top (#2739). A refusal carries no outcome name the way
 * a save does, so without this the page cannot tell whose refusal it is.
 */
export function refusedFromQuery(reason: string, form: string): string {
  return `${refusedQuery(reason)}&form=${encodeURIComponent(form)}`;
}
