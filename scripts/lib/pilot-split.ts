// The judgement behind `pnpm report:pilot-split` (#2898): does Slate lift the
// booking rate over cal.com, measured across trypennie's per lead split?
//
// Pure: no `@/` imports, no file or network reads, no clock. The command
// (scripts/report-pilot-split.ts) reads the export and Slate's own rows and hands
// them here; scripts/test-pilot-split.ts drives every outcome with hand written
// exports.
//
// WHERE THE NUMBERS COME FROM. trypennie (Halo-lab-Trypennie/trypennie#517) splits Low leads on
// `/booking/[SO_ID]` and `/my-offers/result` by `slateBucket(submission id)`
// against `SlatePilotPercent__c`, and pushes `booking_assignment` (with
// `booking_provider` and `submission_id`) on every page load. Booker events
// carry the same two parameters, and reach GA4 named after the step itself
// (`view_booker`, `complete_booking`): GTM renames `cal_booking` by its step. So a
// GA4 Exploration at submission id grain holds both halves' denominators and
// bookings. The warehouse cannot answer it: GA4 reaches Snowflake only as daily
// totals with no event parameters.
//
// FOUR RULES THIS FILE HOLDS, each decided once here:
//
// 1. A lead is a SUBMISSION, counted once, keyed on the first 15 characters of its
//    id (the same key trypennie's hash reads, so the 15 and 18 character forms of
//    one Salesforce id are one lead). `booking_assignment` fires on every visit; a
//    lead who comes back through the Automated Booking Link sends two (#2898).
// 2. A lead is IN the comparison only if it has a `booking_assignment` event.
//    Booker events alone come from pages outside the split (`/offerportal`,
//    `/portal` and anything else still on cal.com), and counting them would put
//    leads the split never saw into the control half.
// 3. A lead seen under BOTH providers is a contradiction: the two pages disagreed
//    about it. It is counted and left out of both halves.
// 4. The export must be limited to PILOT leads. `booking_assignment` fires for
//    every lead on those pages, and a non Low lead is labelled `cal.com`, so an
//    unfiltered export puts High and Medium leads into the control half, which is
//    exactly the lead mix difference the split exists to remove. Either an `xbc`
//    column filters them directly, or the percentage lets the hash find them: a
//    `cal.com` lead whose bucket is UNDER the percentage cannot be a pilot lead.
//    With neither, the population cannot be checked and nothing is reported.

export type Provider = "slate" | "cal.com";

/**
 * Every outcome on its own code, so a shell caller can branch on which one it met
 * and one message never answers for another (L11). Only `compared` is a result.
 */
export const PILOT_SPLIT_EXIT = {
  /** A comparison was made (or, in planning mode, an estimate). */
  compared: 0,
  /** No PILOT_SPLIT_CSV here; nothing was read. */
  notConfigured: 1,
  /** The file is missing, empty, or holds no header row. */
  unreadableFile: 2,
  /** A required column is not in the export. */
  missingColumn: 3,
  /** A date or an event count could not be read. */
  unreadableValue: 4,
  /** PILOT_SPLIT_PERCENT is not a number from 0 to 100. */
  unreadablePercent: 5,
  /** Not one booking_assignment event: the GTM tag is not sending it. */
  noAssignmentEvents: 6,
  /** No xbc column and no percentage, so leads outside the pilot cannot be found. */
  populationUnchecked: 7,
  /** The export holds leads outside the pilot and nothing can remove them. */
  outsidePilot: 8,
  /** One half has no leads at all. */
  emptyHalf: 9,
  /** Plenty of leads and not one booker event: those events are not in the export. */
  noBookerEvents: 10,
  /** A half is below the minimum sample, so the difference is not yet readable. */
  tooFewToRead: 11,
  /** Planning mode was missing an input or given one it cannot use. */
  planRefused: 12,
  /** The comparison was made, and the Slate cross check could not read Slate. */
  crossCheckFailed: 13,
  /** An export ends exactly on a GA4 row limit, so it was probably cut off there (#2908). */
  possiblyTruncated: 14,
  /** Two exports cover the same day, so its leads would be read twice (#2908). */
  overlappingExports: 15,
} as const;

/**
 * Row counts GA4 stops an export at: the Exploration's Show rows choices and its
 * export ceilings. A file whose data rows land exactly on one was almost certainly
 * cut off there, and a cut off export under counts both halves without a word (L98),
 * so it is refused rather than read. Landing on one by chance is rare; the remedy,
 * exporting fewer days per file, costs one more download.
 */
export const GA4_ROW_LIMITS: readonly number[] = [100, 250, 500, 1000, 2500, 5000, 10000, 100000];

/** One GA4 export as the command read it: its path, for naming it in a refusal, and its text. */
export interface ExportFile {
  name: string;
  text: string;
}

/**
 * The minimum sample below which a difference is reported as not yet readable
 * rather than as a finding (L716). The interval below is a normal approximation,
 * which is only honest once each half holds at least ten of each outcome; the lead
 * floor stops a lucky first week of a dozen leads reading as a result.
 */
export const MIN_LEADS_PER_HALF = 100;
export const MIN_OUTCOMES_PER_HALF = 10;

const Z_95 = 1.959963984540054; // two sided alpha 0.05
const Z_POWER_80 = 0.8416212335729143; // power 0.8

/** The booker events that mean the lead OPENED the booker. */
const OPEN_EVENTS = new Set(["view_booker", "navigate_to_booker"]);
const BOOKED_EVENT = "complete_booking";
const ASSIGNMENT_EVENT = "booking_assignment";
/**
 * Every `ga4_event_name` trypennie's booker tracker sends. A lead counts as booked on
 * `complete_booking` whether or not a `cancel_booking` follows: the booking rate is
 * whether the booker converted the lead, and a later cancellation is a separate
 * outcome. The Slate cross check reads Slate's bookings in every status for the same
 * reason, so the two sides count the same leads.
 */
export const BOOKER_EVENTS = new Set([
  "navigate_to_booker",
  "view_booker",
  "reopen_booker",
  "reload_booker",
  "load_slots",
  "complete_booking",
  "cancel_booking",
  "reschedule_booking",
  "fail_booker_load",
]);

/**
 * trypennie's `slateBucket` (src/utils/booking.ts, Halo-lab-Trypennie/trypennie#517), copied exactly: FNV-1a
 * 32 bit over the first 15 characters of the submission id, mod 100. Pinned to
 * trypennie's own output by scripts/fixtures/pilot-split-buckets.json (L26), so a
 * change on either side fails the build rather than quietly re-sorting leads.
 */
export function slateBucket(submissionId: string): number {
  const id = submissionId.slice(0, 15);
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

/** The key one lead is counted under: the 15 character form of its id. */
export function leadKey(submissionId: string): string {
  return submissionId.slice(0, 15);
}

// --- parsing -------------------------------------------------------------------

/** Columns the export must carry, by their normalised header name. */
export const REQUIRED_COLUMNS = [
  "date",
  "submission_id",
  "booking_provider",
  "event_name",
  "event_count",
] as const;
/**
 * Read when present, and not required: trypennie's GTM tag sends each booker step
 * AS the GA4 event name (`view_booker`, `complete_booking`) and no `ga4_event_name`
 * parameter at all, read off the container on 2026-09-30. An export built for a tag
 * that did send it still reads, the step taken from it when it is set.
 */
export const OPTIONAL_STEP_COLUMN = "ga4_event_name";
/** Read when present: restricts the comparison to Low leads directly. */
export const OPTIONAL_XBC_COLUMN = "xbc";

export interface Ga4Row {
  line: number;
  date: string;
  submissionId: string;
  submissionKey: string;
  provider: Provider | null;
  /** The provider value as exported, when it was one this file does not know. */
  unrecognisedProvider: string | null;
  event: string;
  count: number;
  xbc: string | null;
}

export type ParsedExport =
  | {
      ok: true;
      rows: Ga4Row[];
      /** Events carrying no submission id, summed from their counts. */
      withoutSubmission: number;
      hasXbc: boolean;
      /** True when a second table followed the first and was not read. */
      ignoredRemainder: boolean;
      /** Data rows in the table, totals row left out: what a GA4 row limit counts. */
      dataRows: number;
    }
  | { ok: false; exit: number; message: string };

function normaliseHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** GA4's placeholder for a parameter the event did not carry reads as absent. */
function value(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v === "" || v.toLowerCase() === "(not set)") return null;
  return v;
}

/** RFC 4180 records, each with the line it started on. */
function csvRecords(text: string): { line: number; fields: string[]; blank: boolean }[] {
  const out: { line: number; fields: string[]; blank: boolean }[] = [];
  let line = 1;
  let i = 0;
  while (i < text.length) {
    const startLine = line;
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    let rawLen = 0;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
        } else {
          if (ch === "\n") line++;
          field += ch;
        }
        rawLen++;
        continue;
      }
      if (ch === '"') {
        quoted = true;
        rawLen++;
      } else if (ch === ",") {
        fields.push(field);
        field = "";
        rawLen++;
      } else if (ch === "\r") {
        continue;
      } else if (ch === "\n") {
        i++;
        line++;
        break;
      } else {
        field += ch;
        rawLen++;
      }
    }
    fields.push(field);
    out.push({ line: startLine, fields, blank: rawLen === 0 });
  }
  return out;
}

function readDate(raw: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function readCount(raw: string): number | null {
  const v = raw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(v)) return null;
  return Number(v);
}

/**
 * Read a GA4 Exploration CSV export. Every required column must be present, and
 * one that is missing is refused BY NAME (L688): a missing column read as zero
 * would make a half look empty or a booking look absent, which reads as a finding.
 */
export function parseGa4Export(text: string): ParsedExport {
  const records = csvRecords(text);
  let idx = 0;
  while (idx < records.length && (records[idx].blank || records[idx].fields[0].trimStart().startsWith("#"))) idx++;
  if (idx >= records.length) {
    return {
      ok: false,
      exit: PILOT_SPLIT_EXIT.unreadableFile,
      message: "the export holds no header row (it is empty, or only GA4's comment lines)",
    };
  }
  const header = records[idx].fields.map(normaliseHeader);
  const col = new Map<string, number>();
  header.forEach((h, n) => {
    if (!col.has(h)) col.set(h, n);
  });
  const missing = REQUIRED_COLUMNS.filter((c) => !col.has(c));
  if (missing.length > 0) {
    return {
      ok: false,
      exit: PILOT_SPLIT_EXIT.missingColumn,
      message: `the export has no ${missing.join(", ")} column${missing.length === 1 ? "" : "s"} (it has: ${header.join(", ")}). See the Exploration setup in scripts/report-pilot-split.ts.`,
    };
  }
  const hasXbc = col.has(OPTIONAL_XBC_COLUMN);
  const hasStep = col.has(OPTIONAL_STEP_COLUMN);
  const at = (fields: string[], name: string) => fields[col.get(name) as number];

  const rows: Ga4Row[] = [];
  let withoutSubmission = 0;
  let ignoredRemainder = false;
  let dataRows = 0;
  for (idx++; idx < records.length; idx++) {
    const r = records[idx];
    if (r.blank || r.fields[0].trimStart().startsWith("#")) {
      ignoredRemainder = records.slice(idx).some((x) => !x.blank && !x.fields[0].trimStart().startsWith("#"));
      break;
    }
    const f = r.fields;
    const dims = ["date", "submission_id", "booking_provider", "event_name", ...(hasStep ? [OPTIONAL_STEP_COLUMN] : [])].map((n) =>
      value(at(f, n)),
    );
    // GA4 may add a totals row with every dimension blank.
    if (dims.every((d) => d === null)) continue;
    dataRows++;
    const date = readDate((at(f, "date") ?? "").trim());
    if (date === null) {
      return {
        ok: false,
        exit: PILOT_SPLIT_EXIT.unreadableValue,
        message: `line ${r.line}: the date "${at(f, "date") ?? ""}" is not a GA4 date (YYYYMMDD or YYYY-MM-DD)`,
      };
    }
    const count = readCount(at(f, "event_count") ?? "");
    if (count === null) {
      return {
        ok: false,
        exit: PILOT_SPLIT_EXIT.unreadableValue,
        message: `line ${r.line}: the event count "${at(f, "event_count") ?? ""}" is not a whole number`,
      };
    }
    const submissionId = value(at(f, "submission_id"));
    if (submissionId === null) {
      withoutSubmission += count;
      continue;
    }
    const providerRaw = value(at(f, "booking_provider"));
    const p = providerRaw?.toLowerCase() ?? null;
    const provider: Provider | null = p === "slate" ? "slate" : p === "cal.com" ? "cal.com" : null;
    rows.push({
      line: r.line,
      date,
      submissionId,
      submissionKey: leadKey(submissionId),
      provider,
      unrecognisedProvider: provider === null && providerRaw !== null ? providerRaw : null,
      event: ((hasStep ? value(at(f, OPTIONAL_STEP_COLUMN)) : null) ?? value(at(f, "event_name")) ?? "").toLowerCase(),
      count,
      xbc: hasXbc ? value(at(f, OPTIONAL_XBC_COLUMN)) : null,
    });
  }
  return { ok: true, rows, withoutSubmission, hasXbc, ignoredRemainder, dataRows };
}

const EXIT_LABEL: Record<number, string> = {
  [PILOT_SPLIT_EXIT.missingColumn]: "missing-column",
  [PILOT_SPLIT_EXIT.unreadableValue]: "unreadable-value",
  [PILOT_SPLIT_EXIT.unreadableFile]: "unreadable-file",
  [PILOT_SPLIT_EXIT.possiblyTruncated]: "possibly-truncated",
  [PILOT_SPLIT_EXIT.overlappingExports]: "overlapping-exports",
};

/**
 * Several exports read as one (#2908): a split long enough to read outgrows one GA4
 * download, so the runbook exports a week at a time. Every file is parsed and any
 * refusal names the file. A lead may appear in several files (assigned one week,
 * booked the next) and is joined on its submission like any lead within one file;
 * the same DAY in two files is refused instead, because that is the same traffic
 * exported twice. The xbc column is all or nothing: a file without it beside files
 * with it would drop that file's leads as having no code.
 */
export function readExports(exports: readonly ExportFile[]): ParsedExport {
  if (exports.length === 0) {
    return { ok: false, exit: PILOT_SPLIT_EXIT.unreadableFile, message: "no export files were found" };
  }
  const parsed: { name: string; p: Extract<ParsedExport, { ok: true }> }[] = [];
  for (const file of exports) {
    if (file.text.trim() === "") {
      return { ok: false, exit: PILOT_SPLIT_EXIT.unreadableFile, message: `${file.name}: the export is empty` };
    }
    const p = parseGa4Export(file.text);
    if (!p.ok) return { ...p, message: `${file.name}: ${p.message}` };
    if (GA4_ROW_LIMITS.includes(p.dataRows)) {
      return {
        ok: false,
        exit: PILOT_SPLIT_EXIT.possiblyTruncated,
        message:
          `${file.name} holds exactly ${p.dataRows} rows, one of GA4's row limits, so it was probably cut off and would ` +
          "under count both halves. Export fewer days per file and send them all.",
      };
    }
    parsed.push({ name: file.name, p });
  }
  const daysOf = new Map<string, string>();
  for (const { name, p } of parsed) {
    for (const d of new Set(p.rows.map((r) => r.date))) {
      const other = daysOf.get(d);
      if (other !== undefined && other !== name) {
        return {
          ok: false,
          exit: PILOT_SPLIT_EXIT.overlappingExports,
          message: `${other} and ${name} both cover ${d}, so that day's leads would be read twice. Export each day once.`,
        };
      }
      daysOf.set(d, name);
    }
  }
  const withXbc = parsed.filter(({ p }) => p.hasXbc);
  if (withXbc.length > 0 && withXbc.length < parsed.length) {
    const lacking = parsed.filter(({ p }) => !p.hasXbc).map(({ name }) => name);
    return {
      ok: false,
      exit: PILOT_SPLIT_EXIT.missingColumn,
      message: `${lacking.join(", ")} ${lacking.length === 1 ? "has" : "have"} no xbc column while the other exports do. Export every file with the same dimensions.`,
    };
  }
  return {
    ok: true,
    rows: parsed.flatMap(({ p }) => p.rows),
    withoutSubmission: parsed.reduce((n, { p }) => n + p.withoutSubmission, 0),
    hasXbc: withXbc.length === parsed.length,
    ignoredRemainder: parsed.some(({ p }) => p.ignoredRemainder),
    dataRows: parsed.reduce((n, { p }) => n + p.dataRows, 0),
  };
}

// --- per lead -------------------------------------------------------------------

export interface Half {
  leads: number;
  bookings: number;
  opened: number;
  leftWithoutOpening: number;
}

export interface LeadSummary {
  slate: Half;
  calcom: Half;
  contradictions: number;
  withoutAssignment: number;
  unknownProvider: number;
  unrecognisedProviders: string[];
  xbcUnknown: number;
  outsidePilot: number;
  hashDisagrees: number;
  bookerEvents: number;
  assignmentEvents: number;
  dates: string[];
  slateKeys: Set<string>;
  slateBookedKeys: Set<string>;
}

const emptyHalf = (): Half => ({ leads: 0, bookings: 0, opened: 0, leftWithoutOpening: 0 });

export function summarizeLeads(
  parsed: Extract<ParsedExport, { ok: true }>,
  opts: { percent: number | null },
): LeadSummary {
  type Acc = { assigned: boolean; providers: Set<Provider>; opened: boolean; booked: boolean; xbc: string | null };
  const byLead = new Map<string, Acc>();
  const unrecognised = new Set<string>();
  const dates = new Set<string>();
  let bookerEvents = 0;
  let assignmentEvents = 0;
  for (const row of parsed.rows) {
    if (row.count <= 0) continue;
    dates.add(row.date);
    if (row.unrecognisedProvider !== null) unrecognised.add(row.unrecognisedProvider);
    const acc =
      byLead.get(row.submissionKey) ??
      ({ assigned: false, providers: new Set<Provider>(), opened: false, booked: false, xbc: null } as Acc);
    byLead.set(row.submissionKey, acc);
    if (acc.xbc === null && row.xbc !== null) acc.xbc = row.xbc;
    if (row.event === ASSIGNMENT_EVENT) {
      assignmentEvents += row.count;
      acc.assigned = true;
      if (row.provider) acc.providers.add(row.provider);
    } else if (BOOKER_EVENTS.has(row.event)) {
      bookerEvents += row.count;
      if (row.provider) acc.providers.add(row.provider);
      if (OPEN_EVENTS.has(row.event)) acc.opened = true;
      if (row.event === BOOKED_EVENT) {
        acc.booked = true;
        acc.opened = true;
      }
    }
  }

  const s: LeadSummary = {
    slate: emptyHalf(),
    calcom: emptyHalf(),
    contradictions: 0,
    withoutAssignment: 0,
    unknownProvider: 0,
    unrecognisedProviders: [...unrecognised].sort(),
    xbcUnknown: 0,
    outsidePilot: 0,
    hashDisagrees: 0,
    bookerEvents,
    assignmentEvents,
    dates: [...dates].sort(),
    slateKeys: new Set(),
    slateBookedKeys: new Set(),
  };
  for (const [key, acc] of byLead) {
    if (!acc.assigned) {
      s.withoutAssignment++;
      continue;
    }
    if (acc.providers.size > 1) {
      s.contradictions++;
      continue;
    }
    if (acc.providers.size === 0) {
      s.unknownProvider++;
      continue;
    }
    const provider = [...acc.providers][0];
    if (parsed.hasXbc) {
      if (acc.xbc === null) {
        s.xbcUnknown++;
        continue;
      }
      if (!acc.xbc.startsWith("1")) {
        s.outsidePilot++;
        continue;
      }
    }
    if (opts.percent !== null) {
      const expectSlate = slateBucket(key) < opts.percent;
      if (provider === "slate" && !expectSlate) s.hashDisagrees++;
      if (provider === "cal.com" && expectSlate) {
        // With XBC known this is a Low lead the hash says should have had Slate
        // (the pilot was off that day, or the percentage moved). Without it, the
        // likelier reading is a lead that was never in the pilot.
        if (parsed.hasXbc) s.hashDisagrees++;
        else {
          s.outsidePilot++;
          continue;
        }
      }
    }
    const half = provider === "slate" ? s.slate : s.calcom;
    half.leads++;
    if (acc.booked) half.bookings++;
    if (acc.opened) half.opened++;
    else half.leftWithoutOpening++;
    if (provider === "slate") {
      s.slateKeys.add(key);
      if (acc.booked) s.slateBookedKeys.add(key);
    }
  }
  return s;
}

// --- statistics -----------------------------------------------------------------

/** Standard normal CDF, through erf (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export interface Comparison {
  slateRate: number;
  calcomRate: number;
  /** Slate minus cal.com, as a fraction. */
  difference: number | null;
  low: number | null;
  high: number | null;
  p: number | null;
}

/**
 * The difference in booking rate with a 95% interval (two proportion, unpooled
 * standard error) and a two sided p value. A standard error of zero (no bookings,
 * or all bookings, on both sides) has no interval or p value: null, never NaN.
 */
export function compareHalves(
  slate: { leads: number; bookings: number },
  calcom: { leads: number; bookings: number },
): Comparison {
  const p1 = slate.leads > 0 ? slate.bookings / slate.leads : 0;
  const p2 = calcom.leads > 0 ? calcom.bookings / calcom.leads : 0;
  if (slate.leads === 0 || calcom.leads === 0) {
    return { slateRate: p1, calcomRate: p2, difference: null, low: null, high: null, p: null };
  }
  const diff = p1 - p2;
  const se = Math.sqrt((p1 * (1 - p1)) / slate.leads + (p2 * (1 - p2)) / calcom.leads);
  if (!(se > 0)) return { slateRate: p1, calcomRate: p2, difference: diff, low: null, high: null, p: null };
  const z = diff / se;
  return {
    slateRate: p1,
    calcomRate: p2,
    difference: diff,
    low: diff - Z_95 * se,
    high: diff + Z_95 * se,
    p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))),
  };
}

export type DaysNeeded =
  | { ok: true; days: number; slateLeads: number; calcomLeads: number }
  | { ok: false; reason: string };

/**
 * How many days the split needs before a difference of `lift` is readable: the
 * standard two proportion sample size (Fleiss, no continuity correction) at alpha
 * 0.05 two sided and power 0.8, with the halves allocated by `percent`. Returns the
 * days for the SMALLER half to reach its number, which is when both have.
 *
 * `baseRate` is cal.com's booking rate and `lift` the smallest absolute rise worth
 * detecting, both as fractions (0.12 for 12%). A zero rate, a zero lift, no leads,
 * or a split of 0 or 100 has no answer and is refused with a reason.
 */
export function daysNeeded(input: { leadsPerDay: number; percent: number; baseRate: number; lift: number }): DaysNeeded {
  const { leadsPerDay, percent, baseRate, lift } = input;
  for (const [name, v] of Object.entries(input)) {
    if (!Number.isFinite(v)) return { ok: false, reason: `${name} is not a number` };
  }
  if (leadsPerDay <= 0) return { ok: false, reason: "there are no leads a day to split" };
  if (percent <= 0 || percent >= 100) {
    return { ok: false, reason: `a ${percent}% split puts every lead in one half, so there is nothing to compare` };
  }
  if (baseRate <= 0 || baseRate >= 1) return { ok: false, reason: "the base rate must be above 0 and below 1 (0.12 for 12%)" };
  if (lift <= 0) return { ok: false, reason: "the lift to detect must be above 0 (0.02 for two points)" };
  const p1 = baseRate + lift;
  if (p1 >= 1) return { ok: false, reason: "the base rate plus the lift reaches 100%" };
  const p2 = baseRate;
  const share = percent / 100;
  const k = (1 - share) / share; // cal.com leads per Slate lead
  const pbar = (p1 + k * p2) / (1 + k);
  const root =
    Z_95 * Math.sqrt(pbar * (1 - pbar) * (1 + 1 / k)) + Z_POWER_80 * Math.sqrt(p1 * (1 - p1) + (p2 * (1 - p2)) / k);
  const nSlate = (root * root) / (lift * lift);
  const slateLeads = Math.ceil(nSlate);
  const calcomLeads = Math.ceil(nSlate * k);
  const days = Math.max(Math.ceil(slateLeads / (share * leadsPerDay)), Math.ceil(calcomLeads / ((1 - share) * leadsPerDay)));
  return { ok: true, days, slateLeads, calcomLeads };
}

// --- the Slate cross check --------------------------------------------------------

export interface CrossCheck {
  matched: number;
  /** GA4 says the lead booked, and Slate holds no booking for it. */
  ga4Only: number;
  /** Slate holds a booking for a Slate half lead GA4 never saw book. */
  slateOnly: number;
  /** Slate holds a booking for a submission outside this export's Slate half. */
  outsideExport: number;
}

export function crossCheckSlateBookings(input: {
  ga4Booked: Set<string>;
  slateHalf: Set<string>;
  slateRows: string[];
}): CrossCheck {
  const slateKeys = new Set(input.slateRows.map(leadKey));
  let matched = 0;
  let ga4Only = 0;
  for (const k of input.ga4Booked) {
    if (slateKeys.has(k)) matched++;
    else ga4Only++;
  }
  let slateOnly = 0;
  let outsideExport = 0;
  for (const k of slateKeys) {
    if (!input.slateHalf.has(k)) outsideExport++;
    else if (!input.ga4Booked.has(k)) slateOnly++;
  }
  return { matched, ga4Only, slateOnly, outsideExport };
}

export type SlateCheckInput = { ok: true; submissionIds: string[] } | { ok: false; message: string } | { ok: "skipped"; missing: string[] };

// --- the whole judgement ------------------------------------------------------------

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const points = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} points`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Reads PILOT_SPLIT_PERCENT: null when unset, a number from 0 to 100, or a refusal. */
export function readPercent(raw: string | undefined): { ok: true; percent: number | null } | { ok: false; message: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, percent: null };
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return { ok: false, message: `PILOT_SPLIT_PERCENT="${raw}" is not a number from 0 to 100` };
  }
  return { ok: true, percent: n };
}

export interface Judgement {
  exit: number;
  lines: string[];
  /** Earliest and latest date in the export, for the Slate cross check's window. */
  dates: string[];
  slateKeys: Set<string>;
  slateBookedKeys: Set<string>;
}

const BOUNCE_NOTE =
  "Bounce here means a lead who left without opening the booker (no view_booker, navigate_to_booker or complete_booking). " +
  "It is the booker level bounce and reads the same way for both providers. GA4's own session bounce rate cannot be split " +
  "by an event scoped parameter such as booking_provider, so it is not used.";

export function judgePilotSplit(input: {
  /** Every export to read together, or null when PILOT_SPLIT_CSV named none. */
  exports: readonly ExportFile[] | null;
  env: Record<string, string | undefined>;
  slateCheck?: SlateCheckInput;
}): Judgement {
  const lines: string[] = [];
  const out = (exit: number, extra: Partial<Judgement> = {}): Judgement => ({
    exit,
    lines,
    dates: [],
    slateKeys: new Set(),
    slateBookedKeys: new Set(),
    ...extra,
  });

  if (input.exports === null) {
    lines.push("FAILED (not-configured): set PILOT_SPLIT_CSV to the GA4 Exploration export; nothing was read.");
    lines.push("Or set PILOT_SPLIT_PLAN=1 to estimate how many days the split needs before any data exists.");
    return out(PILOT_SPLIT_EXIT.notConfigured);
  }
  const parsed = readExports(input.exports);
  if (!parsed.ok) {
    lines.push(`FAILED (${EXIT_LABEL[parsed.exit] ?? "unreadable-file"}): ${parsed.message}`);
    return out(parsed.exit);
  }
  const pr = readPercent(input.env.PILOT_SPLIT_PERCENT);
  if (!pr.ok) {
    lines.push(`FAILED (unreadable-percent): ${pr.message}.`);
    return out(PILOT_SPLIT_EXIT.unreadablePercent);
  }
  const percent = pr.percent;
  const s = summarizeLeads(parsed, { percent });
  const range = s.dates.length > 0 ? `${s.dates[0]} to ${s.dates[s.dates.length - 1]}` : "no dates";
  const extra = { dates: s.dates, slateKeys: s.slateKeys, slateBookedKeys: s.slateBookedKeys };

  if (s.assignmentEvents === 0) {
    lines.push(
      `FAILED (no-assignment-events): the export (${range}) holds no booking_assignment event, so no lead has a half.`,
      "trypennie pushes booking_assignment to the dataLayer (Halo-lab-Trypennie/trypennie#517), and it reaches GA4 only once a GTM tag sends it " +
        "as a GA4 event with booking_provider and submission_id as parameters. Booker events alone cannot stand in: they " +
        "count only leads who opened the booker, and they also come from pages outside the split.",
    );
    return out(PILOT_SPLIT_EXIT.noAssignmentEvents, extra);
  }

  const excluded: string[] = [];
  if (s.contradictions > 0) excluded.push(`${plural(s.contradictions, "lead")} seen under both providers (the two pages disagreed about them)`);
  if (s.withoutAssignment > 0) excluded.push(`${plural(s.withoutAssignment, "lead")} with booker events and no assignment (a page outside the split)`);
  if (s.unknownProvider > 0) excluded.push(`${plural(s.unknownProvider, "lead")} with no recognisable booking_provider`);
  if (s.xbcUnknown > 0) excluded.push(`${plural(s.xbcUnknown, "lead")} with no xbc value`);
  if (s.outsidePilot > 0) excluded.push(`${plural(s.outsidePilot, "lead")} outside the pilot`);
  if (parsed.withoutSubmission > 0) excluded.push(`${plural(parsed.withoutSubmission, "event")} with no submission id`);
  const notes: string[] = [];
  if (s.unrecognisedProviders.length > 0) notes.push(`booking_provider values this report does not know: ${s.unrecognisedProviders.join(", ")}`);
  if (parsed.ignoredRemainder) notes.push("the export held a second table after the first; only the first was read");

  if (!parsed.hasXbc && percent === null) {
    lines.push(
      "FAILED (population-unchecked): the export has no xbc column and PILOT_SPLIT_PERCENT is not set, so leads outside the " +
        "pilot cannot be found. booking_assignment fires for every lead on those pages and a non Low lead is labelled cal.com, " +
        "so they would sit in the control half. Set PILOT_SPLIT_PERCENT to SlatePilotPercent__c for these days, or add xbc.",
    );
    return out(PILOT_SPLIT_EXIT.populationUnchecked, extra);
  }
  if (!parsed.hasXbc && s.outsidePilot > 0) {
    const share = percent as number;
    const estimate = share > 0 && share < 100 ? Math.round((s.outsidePilot * (100 - share)) / share) : null;
    lines.push(
      `FAILED (outside-pilot): ${plural(s.outsidePilot, "cal.com lead")} in ${range} had a bucket under ${share}%, so they were ` +
        "never in the pilot (not a Low lead, or a day the pilot was off). The hash finds only those; the same kind of lead " +
        "with a bucket over the percentage is indistinguishable from a control lead" +
        (estimate !== null ? `, roughly ${plural(estimate, "more lead")} in the control half` : "") +
        ". Either add an xbc column (trypennie pushing xbc with booking_assignment, registered as a custom dimension), or " +
        "have trypennie push booking_assignment only for pilot leads.",
    );
    return out(PILOT_SPLIT_EXIT.outsidePilot, extra);
  }
  if (s.slate.leads === 0 || s.calcom.leads === 0) {
    lines.push(
      `FAILED (empty-half): in ${range} Slate has ${plural(s.slate.leads, "lead")} and cal.com ${plural(s.calcom.leads, "lead")}; ` +
        "one half is empty, so there is nothing to compare. Is SlatePilotPercent__c set between 0 and 100?",
    );
    if (excluded.length > 0) lines.push(`Left out: ${excluded.join("; ")}.`);
    return out(PILOT_SPLIT_EXIT.emptyHalf, extra);
  }
  // Per half, like the readability floor below: two thin halves with no booker events
  // are too few to read, not evidence the export is missing a filter.
  if (s.bookerEvents === 0 && s.slate.leads >= MIN_LEADS_PER_HALF && s.calcom.leads >= MIN_LEADS_PER_HALF) {
    lines.push(
      `FAILED (no-booker-events): ${plural(s.slate.leads + s.calcom.leads, "lead")} and not one booker event (${[...BOOKER_EVENTS].join(", ")}). ` +
        "The Exploration is missing them: check its Event name filter includes the booker steps (view_booker, complete_booking and the rest).",
    );
    return out(PILOT_SPLIT_EXIT.noBookerEvents, extra);
  }

  const halfLine = (name: string, h: Half) =>
    `${name} ${plural(h.leads, "lead")}, ${plural(h.bookings, "booking")} (${pct(h.bookings / h.leads)}), ` +
    `${h.leftWithoutOpening} left without opening the booker (${pct(h.leftWithoutOpening / h.leads)})`;
  lines.push(`Pilot split, ${range} (${plural(s.dates.length, "day")} in the export)`);
  lines.push(halfLine("Slate:  ", s.slate));
  lines.push(halfLine("cal.com:", s.calcom));

  const short = (h: Half) =>
    h.leads < MIN_LEADS_PER_HALF || h.bookings < MIN_OUTCOMES_PER_HALF || h.leads - h.bookings < MIN_OUTCOMES_PER_HALF;
  if (short(s.slate) || short(s.calcom)) {
    lines.push(
      `Not yet readable: each half needs at least ${MIN_LEADS_PER_HALF} leads, ${MIN_OUTCOMES_PER_HALF} bookings and ` +
        `${MIN_OUTCOMES_PER_HALF} leads who did not book before the difference means anything. No finding is reported.`,
    );
    if (excluded.length > 0) lines.push(`Left out: ${excluded.join("; ")}.`);
    return out(PILOT_SPLIT_EXIT.tooFewToRead, extra);
  }

  const c = compareHalves(s.slate, s.calcom);
  if (c.difference !== null && c.low !== null && c.high !== null && c.p !== null) {
    const pText = c.p < 0.001 ? "below 0.001" : c.p.toFixed(3);
    lines.push(
      `Booking rate, Slate minus cal.com: ${points(c.difference)}, 95% interval ${points(c.low)} to ${points(c.high)}, p ${c.p < 0.001 ? "" : "= "}${pText}`,
    );
    if (c.low > 0) lines.push("Slate's booking rate is higher, and the interval excludes zero.");
    else if (c.high < 0) lines.push("Slate's booking rate is lower, and the interval excludes zero.");
    else lines.push("The interval includes zero: at this sample the two booking rates cannot be told apart.");
  }
  lines.push(BOUNCE_NOTE);
  if (excluded.length > 0) lines.push(`Left out: ${excluded.join("; ")}.`);
  if (percent !== null) {
    lines.push(
      s.hashDisagrees > 0
        ? `Hash check at ${percent}%: ${plural(s.hashDisagrees, "lead")} got the other booker from what slateBucket gives (the percentage moved, or the pilot was off, on some day in the range).`
        : `Hash check at ${percent}%: every lead got the booker slateBucket gives.`,
    );
  }
  for (const n of notes) lines.push(`Note: ${n}.`);

  const perDay = (s.slate.leads + s.calcom.leads) / Math.max(1, s.dates.length);
  lines.push(`Leads a day in this export: ${perDay.toFixed(1)}.`);
  const liftRaw = input.env.PILOT_SPLIT_LIFT;
  if (liftRaw !== undefined && liftRaw.trim() !== "" && percent !== null) {
    const d = daysNeeded({ leadsPerDay: perDay, percent, baseRate: c.calcomRate, lift: Number(liftRaw) });
    lines.push(
      d.ok
        ? `To detect a ${points(Number(liftRaw))} lift over cal.com's ${pct(c.calcomRate)} at this volume: ${plural(d.days, "day")} in all (${d.slateLeads} Slate and ${d.calcomLeads} cal.com leads).`
        : `No days estimate: ${d.reason}.`,
    );
  }

  const check = input.slateCheck;
  if (check === undefined) {
    lines.push("Slate cross check was not run.");
    return out(PILOT_SPLIT_EXIT.compared, extra);
  }
  if (check.ok === "skipped") {
    lines.push(
      `Slate cross check was skipped: ${check.missing.join(" and ")} ${check.missing.length === 1 ? "is" : "are"} not set here, so GA4's Slate bookings were not compared with Slate's own rows.`,
    );
    return out(PILOT_SPLIT_EXIT.compared, extra);
  }
  if (check.ok === false) {
    lines.push(`FAILED (cross-check): the comparison above stands, and Slate's bookings could not be read: ${check.message}`);
    return out(PILOT_SPLIT_EXIT.crossCheckFailed, extra);
  }
  const x = crossCheckSlateBookings({ ga4Booked: s.slateBookedKeys, slateHalf: s.slateKeys, slateRows: check.submissionIds });
  lines.push(
    `Slate cross check: ${x.matched} of ${plural(s.slateBookedKeys.size, "GA4 booking")} have a Slate booking; ` +
      `${x.ga4Only} GA4 bookings have none (a tagging fault); ${x.slateOnly} Slate bookings for Slate half leads GA4 never saw book ` +
      `(GA4 losses such as ad blockers, which undercount the Slate half); ${x.outsideExport} Slate bookings for submissions outside this export's Slate half.`,
  );
  return out(PILOT_SPLIT_EXIT.compared, extra);
}

// --- planning mode --------------------------------------------------------------------

/** PILOT_SPLIT_PLAN=1: the days estimate before any data exists. */
export function planFromEnv(env: Record<string, string | undefined>): { exit: number; lines: string[] } {
  const names = ["PILOT_SPLIT_LEADS_PER_DAY", "PILOT_SPLIT_PERCENT", "PILOT_SPLIT_BASE_RATE", "PILOT_SPLIT_LIFT"] as const;
  const missing = names.filter((n) => (env[n] ?? "").trim() === "");
  if (missing.length > 0) {
    return {
      exit: PILOT_SPLIT_EXIT.planRefused,
      lines: [`FAILED (plan-refused): planning needs ${missing.join(", ")}.`],
    };
  }
  const [leadsPerDay, percent, baseRate, lift] = names.map((n) => Number((env[n] as string).trim()));
  for (const [name, v] of [
    ["PILOT_SPLIT_BASE_RATE", baseRate],
    ["PILOT_SPLIT_LIFT", lift],
  ] as const) {
    if (Number.isFinite(v) && v >= 1) {
      return {
        exit: PILOT_SPLIT_EXIT.planRefused,
        lines: [`FAILED (plan-refused): ${name}=${v} reads as a percentage; give it as a fraction (0.12 for 12%).`],
      };
    }
  }
  const d = daysNeeded({ leadsPerDay, percent, baseRate, lift });
  if (!d.ok) return { exit: PILOT_SPLIT_EXIT.planRefused, lines: [`FAILED (plan-refused): ${d.reason}.`] };
  return {
    exit: PILOT_SPLIT_EXIT.compared,
    lines: [
      `At ${leadsPerDay} pilot leads a day split ${percent}% to Slate, detecting a ${points(lift)} lift over a ${pct(baseRate)} booking rate ` +
        `(95% confidence, 80% power) takes ${d.days} days: ${d.slateLeads} Slate and ${d.calcomLeads} cal.com leads.`,
      "This is an estimate before data; a real run's readability is decided by the report itself.",
    ],
  };
}
