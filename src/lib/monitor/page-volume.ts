/**
 * Low booking volume PER LANDING PAGE (#2738), beside the tier alarm (#1956).
 *
 * WHY. The tier alarm counts every Low booking together, because every Low page
 * moves to Slate at once. Replayed over two held out weeks of real cal.com bookings
 * it catches a full outage in about 30 minutes, and it mostly cannot see ONE page
 * breaking while the others keep booking: the healthy pages hold the total above
 * the floor. A broken Income Verification page (34% of Low) was missed on 8 of 9
 * weekday afternoons, a broken Follow Up page (16%) on 9 of 9 (#2738). Once every page runs
 * through Slate, one page's link or embed breaking is the likeliest outage.
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
 * No `@/` imports, so node scripts can run it directly.
 */
import { SOURCE_DETAILS, SOURCE_NOT_GIVEN, type PageSource } from "../booking/booking-source.ts";
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
import type { ThrottledNotify } from "./alert-deps";

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
 * measurement's own, and `FLOOR_SCOPE` (the tier alarm's scope) is derived from this
 * list, so the tier and the pages are fitted to the same forms by construction.
 */
export const LOW_PAGES: readonly LowPage[] = [
  {
    id: "income-verification",
    name: "Income Verification Phone Call",
    calcomForm: "Income Verification Phone Call (engine /booking/portal and /offerhub)",
    sources: ["booking-portal", "offerhub"],
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
    sources: ["booking", "my-offers-result"],
  },
];

/** alert_state key family: one key per page, so one page's cooldown never silences another's (L707). */
export const PAGE_VOLUME_ALERT_PREFIX = "low_page_volume";

export function pageVolumeAlertKey(id: LowPageId): string {
  return `${PAGE_VOLUME_ALERT_PREFIX}:${id}`;
}

/**
 * How far back a page must have recorded ANY booking before its silence is read as
 * the page breaking. A page whose links carry no `source` records every booking as
 * `not-given`, and would otherwise read as a page that has stopped booking forever.
 */
export const PAGE_SEEN_LOOKBACK_DAYS = 7;

/** "/booking/portal and /offerhub": where a page lives, from the source vocabulary's own names (L41). */
export function pagePlaces(page: LowPage): string {
  const places = page.sources.map((s) => SOURCE_DETAILS[s].page);
  return places.length === 1 ? places[0]! : `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}`;
}

/**
 * Whether the Low pages' bookings carried their source over the alarm's lookback
 * (#2765), as measured by `measurePageSources` for both the alerts settings page and
 * the readiness gate. Each read is null when it failed.
 */
export interface PageSourceMeasure {
  lookbackDays: number;
  /** Real (non test bucket) bookings in the lookback. */
  realBookings: number;
  /** Of those, how many recorded no page (`isUnsourced`). */
  unsourced: number;
  /** Whether each Low page recorded at least one booking carrying one of its sources. */
  pages: { id: LowPageId; name: string; recorded: boolean }[];
}

export type PageSourceStatus =
  | { state: "unreadable"; text: string }
  /** No real booking in the lookback: nothing says whether the links carry a source. */
  | { state: "unmeasured"; text: string }
  /** Some bookings recorded no page, so the pages cannot all be told apart. */
  | { state: "unrecorded"; unsourced: number; total: number; text: string }
  /** Every real booking in the lookback carried a source. */
  | { state: "recorded"; total: number };

/**
 * What a surface that shows the per page floors says in their place until the
 * sources are measured (#2765). Only a lookback in which EVERY real booking carried a
 * source lets the floors stand as coverage: a floor judged against bookings the alarm
 * cannot attribute is not one, and a lookback holding no bookings measured nothing.
 */
export function pageSourceStatus(m: PageSourceMeasure | null): PageSourceStatus {
  if (m === null) {
    return {
      state: "unreadable",
      text: "Whether bookings record which page they came from could not be read, so these floors are not shown as coverage.",
    };
  }
  if (m.realBookings === 0) {
    return {
      state: "unmeasured",
      text:
        `No real booking in the last ${m.lookbackDays} days, so whether each page's links carry ?source= is not ` +
        `measured yet, and no page's own floors can be judged.`,
    };
  }
  if (m.unsourced > 0) {
    const silent = m.pages.filter((p) => !p.recorded).map((p) => p.name);
    return {
      state: "unrecorded",
      unsourced: m.unsourced,
      total: m.realBookings,
      text:
        `${sourceNotRecorded(m.unsourced, m.realBookings, `${m.lookbackDays} days`)}, so a page whose missing ` +
        `bookings could be among them is held rather than paged.` +
        (silent.length ? ` No booking carried the source of: ${silent.join(", ")}.` : ""),
    };
  }
  return { state: "recorded", total: m.realBookings };
}

/** A booking as the per page check needs it: when, and from where. */
export interface SourceRow {
  createdMs: number;
  source: string | null;
}

/**
 * Whether a booking recorded NO page (#2765): `not-given` (the link carried no
 * `?source=`), or null (a booking from before #2072). Such a booking might be ANY
 * page's, so it can hide a page's shortfall. `unrecognised` is not one of them: that
 * link named a page, it was just a name Slate does not know.
 *
 * One predicate, used by the per page alarm on every tick and by the readiness
 * measurement (`measurePageSources`), so the two never count differently (L16).
 */
export function isUnsourced(source: string | null): boolean {
  return source === null || source === SOURCE_NOT_GIVEN;
}

/** The `bookings.source` values `isUnsourced` counts, for a database filter. */
export const UNSOURCED_VALUES = [SOURCE_NOT_GIVEN] as const;

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
  /** The step itself failed; only the lane's step boundary produces this. */
  | { status: "unverified" }
  | {
      status: "checked";
      armed: boolean;
      pages: PageVerdict[];
      /** Of the bookings read for the long window, how many recorded no page (#2765). */
      sources: { unsourced: number; total: number };
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
  baselines: Record<LowPageId, VolumeBaseline>;
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

  const judged = LOW_PAGES.map((page) => {
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
  const unsourcedIn = (ms: number) => rows.filter((r) => isUnsourced(r.source) && inWindow(r, ms)).length;
  const sources = { unsourced: unsourcedIn(longMs), total: rows.filter((r) => inWindow(r, longMs)).length };

  const recovered: { key: string; text: string }[] = [];
  for (const { page, floors, measurable } of judged) {
    if (!measurable) {
      pages.push({ id: page.id, verdict: "unmeasured-hour" });
      continue;
    }
    const mine = rows.filter((r) => r.source !== null && (page.sources as readonly string[]).includes(r.source));
    const since = (ms: number) => mine.filter((r) => inWindow(r, ms)).length;
    // The span of each window below, in the same order.
    const spans = [shortMs, longMs];
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
    // A breach even they cannot cover is a real shortfall, and goes on to page.
    const coverable = windows.every(
      (w, i) => w.count >= w.floor || w.count + unsourcedIn(spans[i]!) >= w.floor,
    );
    if (coverable) {
      pages.push({
        id: page.id,
        verdict: "source-unrecorded",
        windows,
        breaches,
        ...sources,
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
    await deps.notify(pageVolumeAlertKey(page.id), deps.cooldownMs, text).catch(() => {});
    pages.push({ id: page.id, verdict: "low", windows, breaches, action: seen === false ? "paged-unseen" : "paged" });
  }

  deps.log?.({
    armed: deps.armed,
    tier_low: deps.tierLow,
    unsourced: sources.unsourced,
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
  // all-clear-proof: scripts/test-page-volume.ts - pins that an unmeasured hour, a
  // low page, a tick outside business hours and a read that threw each clear
  // NOTHING about that page; only a page measured at or above its floors does.
  if (recovered.length > 0) await deps.resolveRecovered(recovered).catch(() => {});
  return { status: "checked", armed: deps.armed, pages, sources };
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
    `Its links need ${page.sources.map((s) => `source=${s}`).join(" or ")}.`
  );
}

/**
 * The page for one landing page gone quiet. It names the page and its URLs, because
 * the repair is on that page's link or embed, not in the booker every page shares.
 * It says the tier is still above its floor only when the tier alarm measured that.
 */
export function formatPageVolumeAlert(page: LowPage, breaches: VolumeWindow[], tierHealthy: boolean): string {
  const scope = tierHealthy
    ? " Low bookings overall are above their floor, so this looks like that page's link or embed rather than the booker."
    : "";
  return (
    `Bookings from the ${page.name} page (${pagePlaces(page)}) are low: ${describeBreaches(breaches)}` +
    `${scope} Check that page's booking link and embed.`
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
    `page (${pagePlaces(page)}), and it is below its floor now: ${describeBreaches(breaches)} ` +
    `Either that page is not sending leads to Slate, or its booking link does not carry ${sources}, ` +
    `which is how Slate tells the pages apart. Open the page and check where its booking link goes.`
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
