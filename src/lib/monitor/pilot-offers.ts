/**
 * What each booker OFFERS during the pilot split (#2927).
 *
 * During the Low split (Halo-lab-Trypennie/trypennie#517) a difference in booking
 * rate between the halves can come from what each system offered rather than from
 * the booker itself: measured 2026-09-30, cal.com's first time for a Low lead was
 * the next morning with 32 in the next day, while Slate's was that evening with 249.
 * The configured notice pointed the other way, so settings cannot stand in for it.
 *
 * So every quarter hour the monitor lane asks both systems, read only, what a Low
 * lead would be offered, and keeps two numbers from each: the earliest time and how
 * many times fall in the next 24 hours. `pnpm report:pilot-split` shows them beside
 * the booking rates.
 *
 * cal.com is asked through its routing form, not the whole event type, because the
 * form is what decides who a lead on the split pages can be booked with:
 * `POST /v2/routing-forms/{form}/calculate-slots` with the lead's routing fields.
 * It stores no response (measured 2026-09-30: the form's newest response was the
 * same before and after), and it routes (a 412 lead got 3 times where a 112 lead
 * got 35). Slate is asked through the same read its booker uses for the bucket.
 *
 * A failed read is stored as a failure with its reason and NO numbers, never as
 * zero times, because zero is a real answer ("offered nothing") and a failure is not
 * one (L90). Pure and injected, so every path is driven by
 * `scripts/test-pilot-offers.ts`. Retires with the parallel run at cutover (#65).
 */
import { parseStampMs } from "@/lib/date/stamp";

/** How often a sample is taken. */
export const PILOT_OFFER_INTERVAL_MS = 15 * 60_000;

/**
 * Slack on the interval: the monitor lane ticks every five minutes, so without it a
 * tick landing a moment early waits a whole extra tick and a quarter hour drifts to
 * twenty minutes. Half a tick.
 */
const DUE_SLACK_MS = 2.5 * 60_000;

/** The window a count covers. */
const COUNT_WINDOW_MS = 24 * 3_600_000;

/** The Low bucket both systems are asked about, and its routing fields. */
export const PILOT_OFFER_BUCKET = "112";

/**
 * The cal.com routing form Low leads on the split pages route through: Completed
 * Application Review, which `/my-offers/result` and a non AI eligible `/booking`
 * open (trypennie `PRIMARY_BOOKING_LINK`). Its fields are the xbc and its digits.
 */
export const PILOT_OFFER_CALCOM_FORM = "b839aed8-4afd-4bde-8796-68645685adb9";

export function pilotOfferRoutingFields(xbc: string): Record<string, number> {
  return { xbc: Number(xbc), adv: Number(xbc[0]), bes: Number(xbc[1]), leg: Number(xbc[2]) };
}

export type PilotOfferSystem = "slate" | "calcom";

/** One stored reading. `ok` false carries an error and no numbers. */
// A type alias rather than an interface: the typed Supabase client needs a type
// assignable to a string keyed record, which an interface is not.
export type PilotOfferRow = {
  sampled_at: string;
  system: PilotOfferSystem;
  bucket_code: string;
  ok: boolean;
  earliest_offered_at: string | null;
  offered_24h: number | null;
  error: string | null;
};

export function pilotOfferSampleDue(lastSampledAtMs: number | null, nowMs: number): boolean {
  if (lastSampledAtMs === null) return true;
  return nowMs - lastSampledAtMs >= PILOT_OFFER_INTERVAL_MS - DUE_SLACK_MS;
}

/**
 * The earliest time still ahead, and how many fall in the next 24 hours. An
 * unreadable time THROWS: dropping it would report fewer times than were offered.
 */
export function offerSummary(
  times: readonly string[],
  nowMs: number,
): { earliestOfferedAt: string | null; offered24h: number } {
  let earliest: number | null = null;
  let count = 0;
  for (const t of times) {
    const ms = parseStampMs(t);
    if (ms === null) throw new Error(`an offered time could not be read: ${t.slice(0, 40)}`);
    if (ms < nowMs) continue;
    if (earliest === null || ms < earliest) earliest = ms;
    if (ms < nowMs + COUNT_WINDOW_MS) count++;
  }
  return { earliestOfferedAt: earliest === null ? null : new Date(earliest).toISOString(), offered24h: count };
}

/** cal.com's calculate-slots answer: `{ eventTypeId, slots: { [day]: [{ start }] } }`. */
export function readCalcomRoutedSlots(
  status: number,
  data: unknown,
): { ok: true; times: string[] } | { ok: false; reason: string } {
  if (status < 200 || status >= 300) return { ok: false, reason: `cal.com answered ${status}` };
  const slots = (data as { slots?: unknown } | null | undefined)?.slots;
  if (!slots || typeof slots !== "object" || Array.isArray(slots)) {
    return { ok: false, reason: "cal.com answered with no slots field" };
  }
  const times: string[] = [];
  for (const day of Object.values(slots as Record<string, unknown>)) {
    if (!Array.isArray(day)) return { ok: false, reason: "cal.com answered a day that is not a list" };
    for (const slot of day) {
      const start = (slot as { start?: unknown } | null)?.start;
      if (typeof start !== "string") return { ok: false, reason: "cal.com answered a slot with no start time" };
      times.push(start);
    }
  }
  return { ok: true, times };
}

export interface PilotOfferDeps {
  nowMs: number;
  bucketCode: string;
  /** When the newest stored sample was taken, or null when there is none. */
  lastSampledAtMs: () => Promise<number | null>;
  /** cal.com's raw answer for a Low lead's routing fields. */
  readCalcom: () => Promise<{ status: number; data: unknown }>;
  /** The times Slate's booker would serve for the bucket right now. */
  readSlate: () => Promise<string[]>;
  insert: (rows: PilotOfferRow[]) => Promise<void>;
}

export type PilotOfferOutcome =
  | { sampled: false }
  | { sampled: true; calcom: "ok" | "failed"; slate: "ok" | "failed" };

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Take one sample when one is due. Each system has its own failure boundary, so one
 * system's outage never costs the other's reading (L73), and a failure is stored with
 * its reason. Only a failure to STORE throws, so the lane's step streak pages on it.
 */
export async function runPilotOfferSample(deps: PilotOfferDeps): Promise<PilotOfferOutcome> {
  if (!pilotOfferSampleDue(await deps.lastSampledAtMs(), deps.nowMs)) return { sampled: false };
  const sampledAt = new Date(deps.nowMs).toISOString();
  // In the table's column order.
  const base = (system: PilotOfferSystem) => ({ sampled_at: sampledAt, system, bucket_code: deps.bucketCode });
  const measured = (system: PilotOfferSystem, times: string[]): PilotOfferRow => {
    const s = offerSummary(times, deps.nowMs);
    return { ...base(system), ok: true, earliest_offered_at: s.earliestOfferedAt, offered_24h: s.offered24h, error: null };
  };
  const failed = (system: PilotOfferSystem, error: string): PilotOfferRow => ({
    ...base(system),
    ok: false,
    earliest_offered_at: null,
    offered_24h: null,
    error,
  });

  let calcom: PilotOfferRow;
  try {
    const answer = await deps.readCalcom();
    const read = readCalcomRoutedSlots(answer.status, answer.data);
    calcom = read.ok ? measured("calcom", read.times) : failed("calcom", read.reason);
  } catch (err) {
    calcom = failed("calcom", reasonOf(err));
  }
  let slate: PilotOfferRow;
  try {
    slate = measured("slate", await deps.readSlate());
  } catch (err) {
    slate = failed("slate", reasonOf(err));
  }

  await deps.insert([calcom, slate]);
  return { sampled: true, calcom: calcom.ok ? "ok" : "failed", slate: slate.ok ? "ok" : "failed" };
}

export interface SystemOffers {
  samples: number;
  failed: number;
  /** Median minutes from the sample to the earliest time offered, over samples that offered one. */
  medianMinutesToFirst: number | null;
  /** Median count of times in the next 24 hours, over readable samples. */
  medianOffered24h: number | null;
}

export interface PilotOffersSummary {
  slate: SystemOffers;
  calcom: SystemOffers;
  /** Quarter hours where both systems were read. */
  paired: number;
  /** Of those, how many had Slate's earliest time strictly before cal.com's. */
  slateEarlier: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

function summariseSystem(rows: PilotOfferRow[]): SystemOffers {
  const ok = rows.filter((r) => r.ok);
  const waits = ok.flatMap((r) => {
    if (r.earliest_offered_at === null) return [];
    const first = parseStampMs(r.earliest_offered_at);
    const taken = parseStampMs(r.sampled_at);
    return first !== null && taken !== null ? [(first - taken) / 60_000] : [];
  });
  return {
    samples: rows.length,
    failed: rows.length - ok.length,
    medianMinutesToFirst: median(waits),
    medianOffered24h: median(ok.map((r) => r.offered_24h ?? 0)),
  };
}

/**
 * Earliest time as a number, with "offered nothing" as infinitely late. An
 * unreadable stored stamp is also treated as late, so it can never credit either
 * system with the earlier time.
 */
const firstMs = (r: PilotOfferRow): number => parseStampMs(r.earliest_offered_at) ?? Number.POSITIVE_INFINITY;

export function summarisePilotOffers(rows: readonly PilotOfferRow[]): PilotOffersSummary {
  const slateRows = rows.filter((r) => r.system === "slate");
  const calcomRows = rows.filter((r) => r.system === "calcom");
  const calcomAt = new Map(calcomRows.filter((r) => r.ok).map((r) => [r.sampled_at, r]));
  let paired = 0;
  let slateEarlier = 0;
  for (const s of slateRows) {
    const c = calcomAt.get(s.sampled_at);
    if (!s.ok || !c) continue;
    paired++;
    if (firstMs(s) < firstMs(c)) slateEarlier++;
  }
  return { slate: summariseSystem(slateRows), calcom: summariseSystem(calcomRows), paired, slateEarlier };
}

export type PilotOffersRead =
  | { ok: true; summary: PilotOffersSummary }
  | { ok: false; message: string }
  | { ok: "skipped"; missing: string[] };

const wait = (minutes: number | null): string => {
  if (minutes === null) return "nothing offered";
  const m = Math.round(minutes);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

const systemLine = (name: string, s: SystemOffers): string => {
  const readable = s.samples - s.failed;
  const failed = s.failed > 0 ? ` (${s.failed} of ${s.samples} ${name} samples failed and are left out)` : "";
  return (
    `  ${name}: typically ${s.medianOffered24h ?? 0} times in the next 24 hours, first one in ${wait(s.medianMinutesToFirst)}, ` +
    `over ${readable} readable sample${readable === 1 ? "" : "s"}${failed}`
  );
};

/**
 * The report's availability section: what each booker offered a Low lead over the
 * export's days, so a booking rate gap can be read against it. It never reads as
 * "both offered the same" when nothing was measured.
 */
export function pilotOffersReportLines(read: PilotOffersRead): string[] {
  const head = "What each booker offered a Low lead (bucket 112), sampled every 15 minutes:";
  if (read.ok === "skipped") {
    return [head, `  skipped: ${read.missing.join(" and ")} ${read.missing.length === 1 ? "is" : "are"} not set here.`];
  }
  if (read.ok === false) return [head, `  the samples could not be read: ${read.message}`];
  const { slate, calcom, paired, slateEarlier } = read.summary;
  if (slate.samples === 0 && calcom.samples === 0) {
    return [head, "  no availability samples for these dates, so the halves cannot be compared on what they offered."];
  }
  return [
    head,
    systemLine("Slate", slate),
    systemLine("cal.com", calcom),
    paired === 0
      ? "  no quarter hour had both systems read, so neither can be said to have offered earlier."
      : `  Slate offered the earlier first time in ${slateEarlier} of ${paired} quarter hours where both were read.`,
  ];
}

/**
 * The report's read of the samples: skipped with the names of what is missing,
 * failed with its reason, or summarised. Kept apart from the Supabase call so each
 * path is tested.
 */
export async function readPilotOffersForReport(input: {
  /** Credentials the report lacks; empty when it has them. */
  missing: string[];
  fetchRows: () => Promise<PilotOfferRow[]>;
}): Promise<PilotOffersRead> {
  if (input.missing.length > 0) return { ok: "skipped", missing: input.missing };
  try {
    return { ok: true, summary: summarisePilotOffers(await input.fetchRows()) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
