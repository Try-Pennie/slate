/**
 * Low booking volume PER LANDING PAGE (#2738), beside the tier alarm (#1956).
 *
 * WHY. The tier alarm counts every Low booking together, across the Low pages Slate
 * carries (`LOW_PAGES_ON_SLATE`, #2878). Replayed over two held out weeks of real cal.com bookings
 * it catches a full outage in about 30 minutes, and it mostly cannot see ONE page
 * breaking while the others keep booking: the healthy pages hold the total above
 * the floor. A broken Income Verification page (34% of Low) was missed on 8 of 9
 * weekday afternoons, a broken Follow Up page (16%) on 9 of 9 (#2738). Once every page runs
 * through Slate, one page's link or embed breaking is the likeliest outage. Those
 * figures are #2738's, over all three pages and the tier they made up.
 *
 * ONLY THE PAGES SLATE CARRIES ARE JUDGED (#2878). A page held off Slate is not
 * read, paged, cleared or looked up: its silence is the expected state, not an
 * outage, and paging it would say so every afternoon until it is wired.
 *
 * WHAT. Each Low page gets its own floors, fitted with the same `fitFloorCells` to
 * that page's own series in the committed measurement, and judged against the
 * bookings Slate recorded as coming from it (`bookings.source`, #2072).
 *
 * WHERE A PAGE CANNOT BE JUDGED. A page carrying too few bookings in an hour to
 * clear a floor of even 1 in two hours has floors of 0 there, and a floor of 0 can
 * never breach. That hour is reported as UNMEASURED, in those words, rather than
 * as healthy, and it never sends an all-clear: a check that cannot fire is not a
 * check that found nothing wrong (L543, L90). Measured 2026-09-25 (#2738), the Follow Up
 * page is unmeasured on most weekday afternoons and judged in the mornings, which
 * is exactly where a replay shows its outages are and are not caught.
 *
 * ONLY WHILE SLATE TAKES EVERY LOW LEAD. Each page's floors are cal.com's, fitted to
 * every lead on that page. While the pilot splits Low between the two systems, Slate
 * sees only part of each page, too little for a quiet two hours to mean a page broke:
 * thinning the floors to Slate's measured share (#3193) left no hour any page could be
 * judged in at a 44% to 49% split, and a daily message saying so. Dan, 2026-10-08: judge
 * the pages only when the pilot sends Slate every Low lead, read straight from the
 * Salesforce switch trypennie itself reads (`lowPilot`), and say nothing during a split.
 * A switch that cannot be read is the one stand down that says something, once a day,
 * with where to look. The Low tier alarm watches Low as a whole throughout.
 *
 * No `@/` imports, so node scripts can run it directly.
 */
import {
  NON_PAGE_SOURCES,
  PROSPECT_ID,
  SOURCE_DETAILS,
  SOURCE_NOT_GIVEN,
  SUBMISSION_ID,
  isNonPageSource,
  type PageLink,
  type PageSource,
} from "../booking/booking-source.ts";
import {
  describeBreaches,
  describeCounts,
  isBusinessHours,
  lowVolumeBreaches,
  LOW_VOLUME_WINDOW_MINUTES,
  type BusinessHoursConfig,
  type VolumeWindow,
} from "./booking-volume.ts";
import { floorsFor, judgedFloors, type VolumeBaseline } from "./volume-floors.ts";
import type { PilotSettings } from "../salesforce/pilot-settings.ts";
import type { ThrottledNotify } from "./alert-deps";
import { logAlertSendFailure, logAllClearFailure } from "../notify/send-failure.ts";

/** One Low landing page: a cal.com routing form, and the Slate sources its links carry. */
export interface LowPage {
  id: LowPageId;
  /** The page as the team knows it. */
  name: string;
  /** The cal.com routing form its bookings were measured under, exactly as named there. */
  calcomForm: string;
  /** The `bookings.source` values its links carry (#2072), one per URL the form served. */
  sources: readonly PageSource[];
}

export type LowPageId = "income-verification" | "application-review-follow-up" | "application-review";

/**
 * The Low pages, from the live routing forms as recorded on #2072. The order is the
 * measurement's own. Every page keeps its measured floors here whether or not Slate
 * carries it yet; which ones Slate carries is `LOW_PAGES_ON_SLATE` below.
 */
export const LOW_PAGES: readonly LowPage[] = [
  {
    id: "income-verification",
    name: "Income Verification Phone Call",
    calcomForm: "Income Verification Phone Call (engine /booking/portal and /offerhub)",
    sources: ["booking-portal", "offerhub", "income-landing"],
  },
  {
    id: "application-review-follow-up",
    name: "Completed Application Review Follow Up",
    calcomForm: "Completed Application Review Follow Up Routing (ai_agent_eligible true /booking)",
    sources: ["booking-agent-eligible"],
  },
  {
    id: "application-review",
    name: "Completed Application Review",
    calcomForm: "Completed Application Review (/booking ai_agent_eligible false and /my-offers/result)",
    sources: ["booking", "my-offers-result", "pennie", "my-offers-result-2"],
  },
];

/** Why a Low page is not on Slate yet, and the issue that puts it there. */
export interface HeldOffSlate {
  /** In plain words, completing "its leads ...": what stops them reaching Slate. */
  reason: string;
  /** The issue whose change puts the page on Slate, and so deletes this entry. */
  issue: number;
}

/**
 * THE ONE SWITCH for which Low pages send their leads to Slate (#2878).
 *
 * Dan, 2026-09-29: the Low pilot launched on the two trypennie pages already wired
 * to Slate, `/booking/[SO_ID]` and `/my-offers/result`, which are the Completed
 * Application Review page and its Follow Up. Income Verification's surfaces
 * (`/offerportal`, `/portal`, offerhub, `/booking/portal`) joined on 2026-10-01
 * (#2870), so the switch holds nothing today.
 *
 * Everything that judges or describes Low volume reads `LOW_PAGES_ON_SLATE`, derived
 * from this: the Low floors' scope (`FLOOR_SCOPE`, refitted from the committed
 * measurement), the per page alarm, the readiness gate's per page check and the
 * admin page. A page Slate does not carry would otherwise read as a page that
 * stopped booking from the day the alarm is armed, and floors fitted to traffic
 * Slate never sees page on every normal afternoon (108 to 283 false pages in two
 * held out weeks, `scripts/lib/volume-floor-scope.ts`).
 *
 * WIDENING is deleting the page's entry here, then `REFIT=1 pnpm measure:volume-floors`
 * so the Low floors take its traffic in, in the same change. The committed per page
 * floors already cover every Low page, so nothing else moves.
 */
export const LOW_PAGES_NOT_ON_SLATE: Readonly<Partial<Record<LowPageId, HeldOffSlate>>> = {
  // Empty since #2870: trypennie's #519 (merged 2026-10-01) put Income Verification's
  // surfaces behind the Slate switch, so every Low page is judged.
};

/**
 * The Low pages whose leads Slate carries, in the measurement's order. Takes the
 * switch as an input so the held off path is tested while the switch is empty.
 */
export function pagesOnSlate(held: Readonly<Partial<Record<LowPageId, HeldOffSlate>>> = LOW_PAGES_NOT_ON_SLATE): readonly LowPage[] {
  return LOW_PAGES.filter((p) => !(p.id in held));
}

/** The Low pages whose leads Slate carries, in the measurement's order. */
export const LOW_PAGES_ON_SLATE: readonly LowPage[] = pagesOnSlate();

/**
 * One sentence per page held off Slate, for the surfaces that list the pages, so a
 * page missing from a table reads as a decision rather than an oversight (L678).
 */
export function pagesNotOnSlateLines(
  heldOff: Readonly<Partial<Record<LowPageId, HeldOffSlate>>> = LOW_PAGES_NOT_ON_SLATE,
): string[] {
  return LOW_PAGES.flatMap((p) => {
    const held = heldOff[p.id];
    return held ? [`${p.name} is not judged: its leads ${held.reason}.`] : [];
  });
}

/** alert_state key family: one key per page, so one page's cooldown never silences another's (L707). */
export const PAGE_VOLUME_ALERT_PREFIX = "low_page_volume";

export function pageVolumeAlertKey(id: LowPageId): string {
  return `${PAGE_VOLUME_ALERT_PREFIX}:${id}`;
}

/**
 * The condition raised while the per page alarm cannot judge because the pilot switch
 * in Salesforce could not be read. One key for the whole alarm, not one per page: the
 * cause is shared, so one message says it once.
 *
 * The key string predates the switch: it is the one #3193's share stand down used, kept
 * so the stand down already firing when this shipped is settled by the first tick that
 * reads the switch, rather than left open for ever under a key nothing clears.
 */
export const PAGE_VOLUME_PILOT_UNKNOWN_KEY = "page_volume_share_unknown";

/**
 * Daily. Unlike a split, an unreadable switch is somebody's to look at, so it is said
 * again each day it lasts, and no more often.
 */
export const PAGE_VOLUME_PILOT_UNKNOWN_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * Low's tier as the pilot names it: the first digit of a lead's XBC, which is what
 * trypennie's `shouldUseSlate` compares against SlatePilotTiers__c.
 */
export const PILOT_LOW_TIER_DIGIT = "1";

/** What the pilot switch means for Low leads. */
export type LowPilot =
  /** Every Low lead goes to Slate, so each page's floors apply as measured. */
  | { state: "whole" }
  /** Some Low leads go to Slate and the rest to cal.com. */
  | { state: "split"; percent: number }
  /** No Low lead goes to Slate. */
  | { state: "off" }
  /** The settings could not be read. */
  | { state: "unreadable" };

/**
 * The switch as trypennie applies it to a Low lead (`shouldUseSlate`, src/utils/booking.ts
 * in Halo-lab-Trypennie/trypennie), which is the code that actually decides (L620): off
 * unless SlatePilotActive__c is true; Low's digit must be among SlatePilotTiers__c, split
 * on semicolons or commas, where an empty field picks no tiers; an empty percentage means
 * 100; and a lead goes to Slate when its bucket, 0 to 99, is below the percentage. Null
 * settings are a read that failed.
 */
export function lowPilot(settings: PilotSettings | null): LowPilot {
  if (settings === null) return { state: "unreadable" };
  if (settings.active !== true) return { state: "off" };
  const tiers = (settings.tiers ?? "").split(/[;,]/).map((t) => t.trim());
  if (!tiers.includes(PILOT_LOW_TIER_DIGIT)) return { state: "off" };
  const percent = settings.percent ?? 100;
  if (percent >= 100) return { state: "whole" };
  if (percent <= 0) return { state: "off" };
  return { state: "split", percent };
}

const PILOT_SETTINGS_WHERE =
  "open Website Configuration (trypennie.com) in Salesforce and look at Slate Pilot Active, Slate Pilot Percent and Slate Pilot Tiers";

/**
 * The admin page's line about the switch, beside the table of hours each page is judged
 * in. Null when the pages are judged, since then there is nothing to explain.
 */
export function pilotPageLine(pilot: LowPilot): string | null {
  switch (pilot.state) {
    case "whole":
      return null;
    case "split":
      return `Per page Low alerts are off while the pilot sends Slate ${pilot.percent}% of Low leads. They turn on at 100%.`;
    case "off":
      return "Per page Low alerts are off while the pilot sends Slate no Low leads.";
    case "unreadable":
      return `Per page Low alerts are off: the pilot settings in Salesforce could not be read. To check, ${PILOT_SETTINGS_WHERE}.`;
  }
}

/** The condition: the switch could not be read, so no page is judged. */
export function formatPilotUnreadableAlert(): string {
  return (
    "Per page Low alerts are off: Slate could not read the pilot settings in Salesforce, so it cannot tell " +
    `whether every Low lead comes to Slate. To check, ${PILOT_SETTINGS_WHERE}. ` +
    'The reason the read failed is in the Worker logs under tag=monitor, msg "pilot settings unreadable". ' +
    "A full Low outage still alerts."
  );
}

/** The all-clear, hung off a tick that read the switch, in the words of what it read. */
export function formatPilotReadNotice(pilot: Exclude<LowPilot, { state: "unreadable" }>): string {
  if (pilot.state === "whole") {
    return "Per page Low alerts are on: the pilot settings in Salesforce send Slate every Low lead. Nothing to do.";
  }
  const why =
    pilot.state === "split"
      ? `they are off while the pilot sends Slate ${pilot.percent}% of Low leads, and turn on at 100%`
      : "they are off while the pilot sends Slate no Low leads";
  return `Per page Low alerts now follow the pilot settings in Salesforce: ${why}. Nothing to do.`;
}

/**
 * How far back a page must have recorded ANY booking before its silence is read as
 * the page breaking. A page whose links carry no `source` records every booking as
 * `not-given`, and would otherwise read as a page that has stopped booking forever.
 */
export const PAGE_SEEN_LOOKBACK_DAYS = 7;

/**
 * Where to open a page to check it, which every page level message ends with
 * (#3033), read from the source vocabulary's own links so the alerts and the admin
 * pages name the same addresses (L41). One address per line, bare, because that is
 * how Slack links one a reader can tap on a phone, and the only text beside an
 * address is the lead it needs, after a space so it never joins the link.
 *
 * No address shows a booker on its own: every page is opened with a lead's id, and
 * shows Slate's booker only for a lead the pilot sends to Slate (`shouldUseSlate`
 * in trypennie's `src/utils/booking.ts`). Opening a prospect page is not read only
 * either, since it can create a lead from that prospect, so a page with one says so.
 */
export function pageLinkLines(page: LowPage): string {
  const links = page.sources.flatMap((s) => SOURCE_DETAILS[s].links);
  const lines = links.map((l) => (l.only === undefined ? l.url : `${l.url} (${l.only})`));
  const takes = (id: PageLink["id"]) => links.some((l) => l.id === id);
  const fill = [
    takes("submission") ? `a lead's submission id in place of ${SUBMISSION_ID}` : null,
    takes("prospect") ? `a prospect id in place of ${PROSPECT_ID}` : null,
  ].filter((f): f is string => f !== null);
  const prospectWarning = takes("prospect")
    ? " Opening a prospect page can create a lead from that prospect in Salesforce, so use a test prospect, never a customer's."
    : "";
  return (
    `Open the page at:\n${lines.join("\n")}\n` +
    `Put ${fill.join(" and ")}. ${links.length === 1 ? "It" : "Each"} shows Slate's booker only when the pilot sends that lead to Slate.${prospectWarning}`
  );
}

/**
 * Whether the Low pages' bookings carried their source over the alarm's lookback
 * (#2765), as measured by `measurePageSources` for both the alerts settings page and
 * the readiness gate. Each read is null when it failed.
 */
export interface PageSourceMeasure {
  lookbackDays: number;
  /**
   * Real (non test bucket) bookings in the lookback that are page traffic
   * (`isPageTraffic`): a machine caller's booking, through the booking API (#2876)
   * or an MCP channel (#3543), is not counted, or a lookback holding only those
   * would read as every booking having carried a source.
   */
  realBookings: number;
  /** Of those, how many recorded no page (`isUnsourced`). */
  unsourced: number;
  /**
   * Routed Low bookings in the lookback that recorded no source AND no host page
   * (`isHostlessUnsourced`, #2960): made by hand on the standalone booker, so in
   * neither `realBookings` nor `unsourced`, and said on their own line instead.
   */
  hostless: number;
  /** Whether each Low page Slate carries (#2878) recorded at least one booking carrying one of its sources. */
  pages: { id: LowPageId; name: string; recorded: boolean }[];
}

/**
 * Every state carries `note`: how many hand made bookings with no host page were set
 * aside from the share (#2960, `hostlessNotCounted`), or null when none were, or when
 * nothing could be read. A state that has `text` already ends with it, so a surface
 * showing `text` shows it; a surface writing its own words for a state appends `note`.
 */
export type PageSourceStatus =
  | { state: "unreadable"; text: string; note: null }
  /** No real booking in the lookback: nothing says whether the links carry a source. */
  | { state: "unmeasured"; text: string; note: string | null }
  /** Some bookings recorded no page, so the pages cannot all be told apart. */
  | { state: "unrecorded"; unsourced: number; total: number; text: string; note: string | null }
  /** Every real booking in the lookback carried a source. */
  | { state: "recorded"; total: number; note: string | null };

/**
 * What a surface that shows the per page floors says in their place until the
 * sources are measured (#2765). Only a lookback in which EVERY real booking carried a
 * source lets the floors stand as coverage: a floor judged against bookings the alarm
 * cannot attribute is not one, and a lookback holding no bookings measured nothing.
 */
export function pageSourceStatus(m: PageSourceMeasure | null): PageSourceStatus {
  const note = m === null ? null : hostlessNotCounted(m.hostless, `${m.lookbackDays} days`);
  const withNote = (text: string) => (note ? `${text} ${note}` : text);
  if (m === null) {
    return {
      state: "unreadable",
      text: "Whether bookings record which page they came from could not be read, so these floors are not shown as coverage.",
      note: null,
    };
  }
  if (m.realBookings === 0) {
    return {
      state: "unmeasured",
      text: withNote(
        `No real booking in the last ${m.lookbackDays} days, so whether each page's links carry ?source= is not ` +
          `measured yet, and no page's own floors can be judged.`,
      ),
      note,
    };
  }
  if (!bookingSourcesRecorded(m)) {
    const silent = m.pages.filter((p) => !p.recorded).map((p) => p.name);
    return {
      state: "unrecorded",
      unsourced: m.unsourced,
      total: m.realBookings,
      text: withNote(
        `${sourceNotRecorded(m.unsourced, m.realBookings, `${m.lookbackDays} days`)}, so a page whose missing ` +
          `bookings could be among them is held rather than paged.` +
          (silent.length ? ` No booking carried the source of: ${silent.join(", ")}.` : ""),
      ),
      note,
    };
  }
  return { state: "recorded", total: m.realBookings, note };
}

/** A booking as the per page check needs it: when, and from where. */
export interface SourceRow {
  createdMs: number;
  source: string | null;
  /**
   * Whether the booking recorded NO host page at all (#2960), judged by
   * `isHostlessBooking` (offsite-origin.ts) off its recorded origins. Required, so
   * every reader that builds a row has to decide it.
   */
  hostless: boolean;
}

/** The two facts the source share is judged on, as every reader carries them. */
export type SourceFacts = Pick<SourceRow, "source" | "hostless">;

/** Whether the source column itself records no page: `not-given`, or null before #2072. */
function recordsNoPage(source: string | null): boolean {
  return source === null || source === SOURCE_NOT_GIVEN;
}

/**
 * Whether a booking recorded NO page (#2765): `not-given` (the link carried no
 * `?source=`), or null (a booking from before #2072). Such a booking might be ANY
 * page's, so it can hide a page's shortfall. `unrecognised` is not one of them: that
 * link named a page, it was just a name Slate does not know. Nor is a machine
 * source, API (#2876) or MCP (#3543): that booking named its caller and came from no
 * page at all.
 *
 * One predicate, used by the per page alarm on every tick and by the readiness
 * measurement (`measurePageSources`), so the two never count differently (L16).
 */
export function isUnsourced(b: SourceFacts): boolean {
  return recordsNoPage(b.source) && !b.hostless;
}

/**
 * A booking with no source made with NO host page recorded (#2960, decided by Dan
 * 2026-10-01): typed by hand on the standalone booker, an admin booking, never a
 * landing page's. It does not count toward the unsourced share that holds a page,
 * nor toward the total that share is quoted against, because it could not have been
 * any page's missing booking. It is still counted, on its own line
 * (`hostlessNotCounted`), so a page that dropped its embed AND its source shows.
 * A hostless booking that DID name a page is that page's, and stays so.
 */
export function isHostlessUnsourced(b: SourceFacts): boolean {
  return recordsNoPage(b.source) && b.hostless;
}

/**
 * "4 bookings in the last 7 days were made with no host page ...": the one line
 * every surface uses for the bookings `isHostlessUnsourced` sets aside, or null
 * when there were none.
 */
export function hostlessNotCounted(n: number, span: string): string | null {
  if (n === 0) return null;
  return n === 1
    ? `1 booking in the last ${span} was made with no host page and carried no source, so it is not counted toward that share.`
    : `${n} bookings in the last ${span} were made with no host page and carried no source, so they are not counted toward that share.`;
}

/**
 * Whether the Low pages' bookings recorded their source well enough for the per page
 * floors to stand as coverage (#2796): the lookback held real bookings, and not ONE
 * of them was `isUnsourced`. A single untagged booking can be the missing booking of
 * a page that stopped, and the alarm then holds that page rather than paging it, so
 * a lookback carrying any is not recorded well enough, however many pages also
 * recorded bookings of their own.
 *
 * The one rule for it: the alerts settings page reads it through `pageSourceStatus`,
 * and the readiness gate reads that same status, so the two cannot answer the same
 * bookings differently (L53, L342). Whether each PAGE recorded a booking is a
 * separate question, asked of `pages`, and never a substitute for this one.
 */
export function bookingSourcesRecorded(m: PageSourceMeasure): boolean {
  return m.realBookings > 0 && m.unsourced === 0;
}

/** The `bookings.source` values `isUnsourced` counts, for a database filter. */
export const UNSOURCED_VALUES = [SOURCE_NOT_GIVEN] as const;

/**
 * Whether a booking is, or might be, a landing page's (#2876). A booking made by a
 * machine caller records it: the key authed booking API its caller (`api-regal`, and
 * so on), an MCP channel its channel (`mcp-marcia`, #3543), and a staff page its page
 * (`coordinator`, #4200). Each came from no landing page, so it is not page traffic: it can neither excuse a page's
 * shortfall nor stand in the count the unsourced share is quoted against. Every
 * other value is, including `not-given` and null, which might be any page's.
 *
 * One predicate for the per page step and the measurement (`measurePageSources`),
 * so the two never disagree about what the pages could have sent (L16).
 */
export function isPageTraffic(source: string | null): boolean {
  return !isNonPageSource(source);
}

/** The `bookings.source` values `isPageTraffic` leaves out, for a database filter.
 *  Every machine source, API and MCP (#3543), and every staff page (#4200), from the
 *  one list. */
export const NON_PAGE_VALUES = NON_PAGE_SOURCES;

/**
 * `isPageTraffic` as a PostgREST `or()` filter, for the reads that count or learn
 * from page traffic (the tier alarm's count, the floor learner's read). Null, a
 * booking from before #2072, is named explicitly because `not in` alone drops it.
 */
export function pageTrafficFilter(): string {
  return `source.is.null,source.not.in.(${NON_PAGE_VALUES.join(",")})`;
}

/**
 * "Source not recorded on 3 of 40 bookings in the last 7 days": the one sentence every
 * surface uses in place of a floor while bookings arrive without a page (#2765), so
 * the alarm, the alerts settings page and the readiness gate say it the same way.
 */
export function sourceNotRecorded(unsourced: number, total: number, span: string): string {
  return `Source not recorded on ${unsourced} of ${total} booking${total === 1 ? "" : "s"} in the last ${span}`;
}

export type PageVerdict =
  /** Both floors are 0 this hour: too few bookings to judge, so nothing was judged. */
  | { id: LowPageId; verdict: "unmeasured-hour" }
  /**
   * Below its floor, AND enough bookings recorded no page to make up the shortfall
   * (#2765): whether this page stopped booking or its links stopped carrying
   * `?source=` cannot be told apart, so it is held rather than paged or cleared.
   */
  | {
      id: LowPageId;
      verdict: "source-unrecorded";
      windows: VolumeWindow[];
      breaches: VolumeWindow[];
      /** Bookings in the long window that recorded no page, of `total` read. */
      unsourced: number;
      total: number;
      /** What the step says in place of a floor. */
      text: string;
    }
  | { id: LowPageId; verdict: "healthy"; windows: VolumeWindow[] }
  | {
      id: LowPageId;
      verdict: "low";
      windows: VolumeWindow[];
      breaches: VolumeWindow[];
      /**
       * What was done about it: paged, paged as a page that has recorded nothing at
       * all, or held because the alarm is disarmed or the tier alarm already
       * reports the same silence.
       */
      action: "paged" | "paged-unseen" | "held-disarmed" | "held-tier";
    };

export type PageVolumeResult =
  | { status: "outside-hours" }
  /** The pilot does not send Slate every Low lead, or its switch could not be read. No booking is read and no page is paged or cleared. */
  | { status: "not-judged"; pilot: Exclude<LowPilot, { state: "whole" }> }
  /** The step itself failed; only the lane's step boundary produces this. */
  | { status: "unverified" }
  | {
      status: "checked";
      armed: boolean;
      pages: PageVerdict[];
      /**
   * Of the bookings read for the long window, how many recorded no page (#2765),
   * and how many were set aside as made with no host page (#2960).
   */
      sources: { unsourced: number; total: number; hostless: number };
    };

/**
 * The per page step. It reads ONE list of the last two hours' customer bookings
 * and counts each page from it in code, so three pages cost one subrequest rather
 * than six on a budget four cron lanes share, and it reads nothing at all in an
 * hour where no page can be judged.
 *
 * A failed read THROWS rather than returning an empty list: an empty list is every
 * page at zero, which is the answer that pages. The lane's step boundary reports a
 * throwing step on its own key.
 */
export async function runPageVolumeCheck(deps: {
  nowMs: number;
  businessHours: BusinessHoursConfig;
  /** Each page's cal.com floors for the whole page, applied as measured. */
  baselines: Record<LowPageId, VolumeBaseline>;
  /**
   * The pilot settings from Salesforce. Asked once, only inside business hours. Throws
   * when the read fails, which stands the step down as unreadable.
   */
  readPilot: () => Promise<PilotSettings>;
  /** The held off switch, an input so its path is tested while it is empty (#2878). */
  heldOff?: Readonly<Partial<Record<LowPageId, HeldOffSlate>>>;
  /** Customer bookings created at or after `sinceIso`. Throws when the read fails. */
  readSources: (sinceIso: string) => Promise<SourceRow[]>;
  /**
   * Whether ANY booking from these sources was recorded at or after `sinceIso`.
   * Asked only on the paging path, so a healthy tick costs nothing extra.
   */
  pageSeenSince: (sources: readonly PageSource[], sinceIso: string) => Promise<boolean>;
  /**
   * Whether the tier alarm judged this tick low (true), healthy (false), or could
   * not judge it (null). While the tier is low it has already paged about the same
   * silence, so a page per page would say one thing four times.
   */
  tierLow: boolean | null;
  armed: boolean;
  cooldownMs: number;
  notify: ThrottledNotify;
  resolveRecovered: (recovered: { key: string; text: string }[]) => Promise<string[]>;
  log?: (fields: Record<string, unknown>) => void;
}): Promise<PageVolumeResult> {
  if (!isBusinessHours(deps.nowMs, deps.businessHours)) return { status: "outside-hours" };
  const pilot = lowPilot(
    await deps.readPilot().catch((err: unknown) => {
      deps.log?.({ msg: "pilot settings unreadable", error: err instanceof Error ? err.message : String(err) });
      return null;
    }),
  );
  if (pilot.state === "unreadable") {
    // The one stand down that speaks: somebody has to look at the switch. Disarmed, the
    // alarm pages nobody anyway, so there is nothing it has stopped doing.
    if (deps.armed) {
      await deps
        .notify(PAGE_VOLUME_PILOT_UNKNOWN_KEY, PAGE_VOLUME_PILOT_UNKNOWN_COOLDOWN_MS, formatPilotUnreadableAlert())
        .catch(logAlertSendFailure(PAGE_VOLUME_PILOT_UNKNOWN_KEY));
    }
    return { status: "not-judged", pilot };
  }
  if (pilot.state !== "whole") {
    // A split, or no Low lead on Slate: expected while the pilot runs, so nothing is said.
    // The switch WAS read, which ends an earlier "could not read it" message.
    deps.log?.({ pilot: pilot.state, percent: pilot.state === "split" ? pilot.percent : null });
    // all-clear-proof: scripts/test-page-volume.ts - pins that only a tick that read the
    // switch clears the unreadable condition, never one outside hours or one that failed.
    await deps
      .resolveRecovered([{ key: PAGE_VOLUME_PILOT_UNKNOWN_KEY, text: formatPilotReadNotice(pilot) }])
      .catch(logAllClearFailure([PAGE_VOLUME_PILOT_UNKNOWN_KEY]));
    return { status: "not-judged", pilot };
  }

  const judged = pagesOnSlate(deps.heldOff).map((page) => {
    const floors = judgedFloors(
      floorsFor({ baseline: deps.baselines[page.id], override30: null, override120: null }, deps.nowMs),
    );
    return { page, floors, measurable: floors.floor30 > 0 || floors.floor120 > 0 };
  });

  const pages: PageVerdict[] = [];
  const longMs = LOW_VOLUME_WINDOW_MINUTES.long * 60_000;
  const shortMs = LOW_VOLUME_WINDOW_MINUTES.short * 60_000;
  const rows = judged.some((j) => j.measurable)
    ? await deps.readSources(new Date(deps.nowMs - longMs).toISOString())
    : [];

  const inWindow = (r: SourceRow, ms: number) => r.createdMs >= deps.nowMs - ms && r.createdMs < deps.nowMs;
  const unsourcedIn = (ms: number) => rows.filter((r) => isUnsourced(r) && inWindow(r, ms)).length;
  // #2876: the share is quoted against what the pages could have sent, so a machine
  // caller's booking, API or MCP (#3543), which names its caller and never a page, is
  // not in the total, and #2960:
  // nor is a booking made by hand with no host page and no source.
  const sources = {
    unsourced: unsourcedIn(longMs),
    total: rows.filter((r) => isPageTraffic(r.source) && !isHostlessUnsourced(r) && inWindow(r, longMs)).length,
    hostless: rows.filter((r) => isHostlessUnsourced(r) && inWindow(r, longMs)).length,
  };

  // The untagged bookings left to excuse short pages with, spent as pages are excused.
  // Kept as BOOKINGS rather than one count per window (#2795): the short window sits
  // inside the long one, so a recent booking is in both, and a count per window would
  // let it excuse one page's 30 minute shortfall AND another page's 120 minute
  // shortfall. So it is split by where each booking sits: `recent` is in both windows,
  // `older` only in the long one, and a booking is spent on at most one page.
  let unsourcedPool = { recent: unsourcedIn(shortMs), older: unsourcedIn(longMs) - unsourcedIn(shortMs) };

  const recovered: { key: string; text: string }[] = [];
  for (const { page, floors, measurable } of judged) {
    if (!measurable) {
      pages.push({ id: page.id, verdict: "unmeasured-hour" });
      continue;
    }
    const mine = rows.filter((r) => r.source !== null && (page.sources as readonly string[]).includes(r.source));
    const since = (ms: number) => mine.filter((r) => inWindow(r, ms)).length;
    const windows: VolumeWindow[] = [
      { label: `${LOW_VOLUME_WINDOW_MINUTES.short} min`, count: since(shortMs), floor: floors.floor30, basis: floors.basis30 },
      { label: `${LOW_VOLUME_WINDOW_MINUTES.long} min`, count: since(longMs), floor: floors.floor120, basis: floors.basis120 },
    ];
    const breaches = lowVolumeBreaches(windows);
    if (breaches.length === 0) {
      pages.push({ id: page.id, verdict: "healthy", windows });
      recovered.push({ key: pageVolumeAlertKey(page.id), text: formatPageVolumeRecoveryNotice(page, windows) });
      continue;
    }
    // Every breach one the untagged bookings could make up: this page's bookings may
    // be arriving without their source, so the counts cannot say it stopped (#2765).
    // The untagged bookings are ONE pool, spent once across the pages in the list's
    // order: the same three bookings cannot be the missing three of two pages. A
    // shortfall the pool left cannot cover is a real one, and goes on to page.
    const [short, long] = windows.map((w) => Math.max(0, w.floor - w.count));
    const left = spendUnsourced(unsourcedPool, short!, long!);
    if (left) {
      unsourcedPool = left;
      pages.push({
        id: page.id,
        verdict: "source-unrecorded",
        windows,
        breaches,
        unsourced: sources.unsourced,
        total: sources.total,
        text: formatPageSourceUnrecorded(page, sources.unsourced, sources.total),
      });
      continue;
    }
    if (!deps.armed) {
      pages.push({ id: page.id, verdict: "low", windows, breaches, action: "held-disarmed" });
      continue;
    }
    if (deps.tierLow === true) {
      pages.push({ id: page.id, verdict: "low", windows, breaches, action: "held-tier" });
      continue;
    }
    // A lookup that fails leaves the ordinary wording, which is still true: the
    // counts above were measured. Only a definite "never" changes what is said.
    const seen = await deps
      .pageSeenSince(page.sources, new Date(deps.nowMs - PAGE_SEEN_LOOKBACK_DAYS * 86_400_000).toISOString())
      .catch(() => null);
    const text =
      seen === false
        ? formatPageUnseenAlert(page, breaches)
        : formatPageVolumeAlert(page, breaches, deps.tierLow === false);
    await deps.notify(pageVolumeAlertKey(page.id), deps.cooldownMs, text).catch(logAlertSendFailure(pageVolumeAlertKey(page.id)));
    pages.push({ id: page.id, verdict: "low", windows, breaches, action: seen === false ? "paged-unseen" : "paged" });
  }

  deps.log?.({
    armed: deps.armed,
    tier_low: deps.tierLow,
    unsourced: sources.unsourced,
    hostless: sources.hostless,
    read: sources.total,
    pages: pages
      .map((p) =>
        p.verdict === "unmeasured-hour"
          ? `${p.id}=unmeasured`
          : `${p.id}=${p.windows.map((w) => `${w.count}/${w.floor}`).join(",")}${
              p.verdict === "low" ? `:${p.action}` : p.verdict === "source-unrecorded" ? ":source-unrecorded" : ""
            }`,
      )
      .join(" "),
  });
  // The switch was read and every page reached a verdict, measured or unmeasured, so the
  // alarm is judging: that ends the unreadable condition.
  recovered.push({ key: PAGE_VOLUME_PILOT_UNKNOWN_KEY, text: formatPilotReadNotice(pilot) });
  // all-clear-proof: scripts/test-page-volume.ts - pins that an unmeasured hour, a
  // low page, a tick outside business hours and a read that threw each clear
  // NOTHING about that page; only a page measured at or above its floors does. And
  // that the pilot condition is cleared only by a tick that read the switch, never by
  // one that could not, was outside hours, or threw.
  if (recovered.length > 0) {
    await deps
      .resolveRecovered(recovered)
      .catch(logAllClearFailure(recovered.map((r) => r.key)));
  }
  return { status: "checked", armed: deps.armed, pages, sources };
}

/** The untagged bookings in the long window: `recent` also in the short one, `older` not. */
export interface UnsourcedPool {
  recent: number;
  older: number;
}

/**
 * Whether the untagged bookings left can make up one page's shortfall, and what is
 * left if they can (#2795). A page short by `short` in the 30 minute window and by
 * `long` in the 120 minute window needs `short` bookings from inside the 30 minutes,
 * each of which also counts toward its 120 minute shortfall, and the rest of the long
 * shortfall from anywhere in the two hours. That rest is taken from the older bookings
 * first, so the recent ones, the only ones a 30 minute shortfall can use, stay for the
 * pages after it. Null when the pool cannot cover the page.
 */
export function spendUnsourced(pool: UnsourcedPool, short: number, long: number): UnsourcedPool | null {
  if (short > pool.recent) return null;
  const rest = Math.max(0, long - short);
  const fromOlder = Math.min(rest, pool.older);
  const fromRecent = rest - fromOlder;
  if (short + fromRecent > pool.recent) return null;
  return { recent: pool.recent - short - fromRecent, older: pool.older - fromOlder };
}

/**
 * What the step says about a page it held because bookings recorded no page (#2765),
 * in place of a floor. It names the one repair that ends it, which is on the landing
 * page's link rather than in Slate.
 */
export function formatPageSourceUnrecorded(page: LowPage, unsourced: number, total: number): string {
  return (
    `${sourceNotRecorded(unsourced, total, `${LOW_VOLUME_WINDOW_MINUTES.long} min`)}, enough to be the ` +
    `${page.name} page's missing bookings, so whether that page stopped booking cannot be told. ` +
    `Its links need ${page.sources.map((s) => `source=${s}`).join(" or ")}.\n` +
    pageLinkLines(page)
  );
}

/**
 * The page for one landing page gone quiet. It names the page and ends with its
 * addresses, because the repair is on that page's link or embed, not in the booker
 * every page shares. It says the tier is still above its floor only when the tier
 * alarm measured that.
 */
export function formatPageVolumeAlert(page: LowPage, breaches: VolumeWindow[], tierHealthy: boolean): string {
  const scope = tierHealthy
    ? " Low bookings overall are above their floor, so this looks like that page's link or embed rather than the booker."
    : "";
  return (
    `Bookings from the ${page.name} page are low: ${describeBreaches(breaches)}` +
    `${scope} Check that page's booking link and embed.\n` +
    pageLinkLines(page)
  );
}

/**
 * The page for a landing page that has recorded no booking at all in the lookback.
 * That is one of two different faults, and the message cannot tell which, so it
 * names both and says how to tell them apart (L11).
 */
export function formatPageUnseenAlert(page: LowPage, breaches: VolumeWindow[]): string {
  const sources = page.sources.map((s) => `source=${s}`).join(" or ");
  return (
    `No booking in the last ${PAGE_SEEN_LOOKBACK_DAYS} days is recorded as coming from the ${page.name} ` +
    `page, and it is below its floor now: ${describeBreaches(breaches)} ` +
    `Either that page is not sending leads to Slate, or its booking link does not carry ${sources}, ` +
    `which is how Slate tells the pages apart. Open the page and check where its booking link goes.\n` +
    pageLinkLines(page)
  );
}

/** The all-clear for one page, hung off counts that were measured at or above both floors. */
export function formatPageVolumeRecoveryNotice(page: LowPage, windows: VolumeWindow[]): string {
  return (
    `Bookings from the ${page.name} page are back above the expected minimum: ${describeCounts(windows)}. ` +
    `The earlier page about it is cleared. No action is needed.`
  );
}

/** How much of a page's open week the check can judge, and the words that say so. */
export interface PageCoverage {
  /** Hours of the org's open week (an hour counts when any of it is open). */
  open: number;
  /** Of those, the hours with a floor that can breach. */
  judged: number;
  /** True when no open hour can be judged: the page is not covered by this check at all. */
  unmeasured: boolean;
  text: string;
}

/**
 * The declaration a page's floors make about themselves (L678). A floor of 0 at an
 * hour is not coverage, so this counts the OPEN hours that can breach and says in
 * words what the rest are, rather than letting a table of zeros read as a quiet
 * page. Judged against the org's weekly rules, the same week the check runs in;
 * a dated closure changes no hour of the typical week, so exceptions are not read.
 */
export function pageCoverage(
  page: LowPage,
  baseline: VolumeBaseline,
  week: Pick<BusinessHoursConfig, "rules">,
): PageCoverage {
  let open = 0;
  let judged = 0;
  baseline.cells.forEach((day, i) => {
    day.forEach((c, hour) => {
      const isOpen = week.rules.some(
        (r) => r.weekday === i + 1 && r.start_minute < (hour + 1) * 60 && hour * 60 < r.end_minute,
      );
      if (!isOpen) return;
      open++;
      if (c.floor30 > 0 || c.floor120 > 0) judged++;
    });
  });
  if (judged === 0) {
    return {
      open,
      judged,
      unmeasured: true,
      text:
        `${page.name}: UNMEASURED. It carries too few bookings in any two open hours to judge, ` +
        `so this check cannot tell when it stops booking.`,
    };
  }
  const rest = open - judged;
  return {
    open,
    judged,
    unmeasured: false,
    text:
      rest === 0
        ? `${page.name}: judged in every open hour.`
        : `${page.name}: judged in ${judged} of ${open} open hours a week. The other ${rest} are UNMEASURED: ` +
          `too few bookings in two hours to judge, so a break that starts there is not caught by this check.`,
  };
}
