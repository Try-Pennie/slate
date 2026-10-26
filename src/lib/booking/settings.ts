import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { BookingSettings } from "@/lib/db/types";
import { parseStampMs } from "@/lib/date/stamp";
import { DAYS_OFFERED_CEILING } from "@/lib/booking/days-offered";

/**
 * Org-wide booking horizon (#216, folds in audit AUD-076). Precedence store > env >
 * coded default, mirroring loadMonitorSettings.
 *
 * Counts BOOKABLE days, not calendar days (#1326). Since #2840 it is NOT how many
 * days a lead is offered: that is `booking_settings.offered_open_days` (#3922). It
 * is how far the last resort (#2841) may reach when every tier a lead may use is
 * full for those days, and how far ahead availability is computed. The admin page
 * edits it as offered open days plus "Last resort extra days" and stores the sum
 * here (#3922, `parseDaysOfferedForm`). A closed day inside the run does not use one up, so
 * the furthest date reaches beyond this number, and the window actually computed is
 * `searchWindowDays(horizon)` in `availability/bookable-days.ts`.
 *
 * Nothing enforces this as a booking LIMIT. There is no horizon check on the write
 * path, so a key-authed caller can book past it; this only shapes what is computed
 * and offered. Widening it therefore cannot let anyone book something they could
 * not book before.
 *
 * The cap is 7 (HORIZON_MAX, which is `DAYS_OFFERED_CEILING`, mirrored by the
 * check constraint in migration 0087),
 * because per-bucket recompute cost is ~super-linear in the window and the
 * recompute lane is tuned for a small one. A 14 day cap was once held back behind
 * the 200-agent load soak; that soak ran and passed on 2026-07-08 (#440) and the
 * cap stayed at 7: the recompute lane has since been measured at 100 to 120
 * percent of its budget on the hot roster (#2022), and on 2026-09-15 Dan chose to
 * keep this at four days rather than widen it (#2360). That was before #2840, when
 * it was still the window a lead was offered; it is the last resort's reach now,
 * and what a lead is offered is the stored offered open days. The search allowance is small for
 * the same reason.
 */
export const HORIZON_DEFAULT = 4;
export const HORIZON_MIN = 1;
export const HORIZON_MAX = DAYS_OFFERED_CEILING;

const validHorizon = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= HORIZON_MIN && n <= HORIZON_MAX;

/** Pure precedence resolver: a valid stored value wins, else a valid env value,
 *  else the coded default. "Valid" = whole number within [HORIZON_MIN, HORIZON_MAX]. */
export function resolveHorizonDays(
  stored: number | null | undefined,
  env: number | undefined,
  def: number,
): number {
  if (validHorizon(stored)) return stored;
  if (validHorizon(env)) return env;
  return def;
}

/**
 * How long the booker's event description may be (#1335).
 *
 * It is one panel a lead reads before committing, and the same string rides into
 * the Regal payload, so this is a real ceiling rather than a guess: past it the
 * panel stops being read and starts being scrolled. Generous enough for a
 * description plus an ask, which is the shape Dan wrote it in.
 */
export const EVENT_DESCRIPTION_MAX = 1200;

export interface EventDescriptionPayload {
  /** The value to store, or null to clear it. */
  description: string | null;
  errors: string[];
}

/**
 * Parse and normalise the admin settings form's description field (#1335).
 *
 * Blank CLEARS it, which is not an error: an org may want no description at all,
 * and storing an empty string instead would leave the booker rendering an empty
 * panel rather than none.
 *
 * Normalised on the way IN, so the stored value is the one thing every surface
 * reads and none of them has to decide what four blank lines meant. Windows line
 * endings become newlines, trailing spaces go, and a run of blank lines collapses
 * to the one that separates two paragraphs. A SINGLE line break is left alone: the
 * author meant it, and reflowing somebody's short list would be the editor
 * silently rewriting their copy.
 *
 * Over-long is REFUSED rather than truncated. Storing half a sentence would put a
 * cut-off instruction in front of every lead, and the author would have no way to
 * know (L5: never destroy good state, and never accept a value you will damage).
 *
 * Pure, so it is node-testable without a database.
 */
export function parseEventDescriptionForm(raw: string): EventDescriptionPayload {
  const normalized = (raw ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized === "") return { description: null, errors: [] };
  if (normalized.length > EVENT_DESCRIPTION_MAX) {
    return {
      description: null,
      errors: [
        `The description is ${normalized.length} characters. Please keep it to ` +
          `${EVENT_DESCRIPTION_MAX} or fewer.`,
      ],
    };
  }
  return { description: normalized, errors: [] };
}

/**
 * A stored `horizon_days` resolved the way every reader resolves it: the stored
 * value, else the env value, else the coded default. For a caller that read the row
 * itself (the Days offered card reads both of its columns in one read, #3922).
 */
export function horizonFromStored(stored: number | null | undefined): number {
  return resolveHorizonDays(stored, envHorizon(), HORIZON_DEFAULT);
}

const envHorizon = (): number | undefined => {
  const raw = process.env.SLATE_BOOKING_HORIZON_DAYS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * The org-wide horizon, or **null** when the read FAILED (#1654).
 *
 * The honest read, and the one predicate every caller that MEASURES against the
 * window shares. Two consumers used to disagree about what an unreadable horizon
 * means, and they cannot both have been right: the admin supply page took the
 * coded default and presented the result as measured, while the monitor lane
 * treats a guessed horizon as unsafe because a probe compared against a row
 * computed over a different window reads as drift (#216).
 *
 * The monitor is the one that was right, and the reason generalises: the horizon
 * decides both how far ahead the booker offers and the window availability is
 * computed over, so a guessed one silently changes what a reading MEANS rather
 * than making it unavailable. A number computed against the wrong window is worse
 * than a missing one, because nothing about it looks wrong.
 *
 * Worse, the monitor's refusal could never actually FIRE. It reads the horizon
 * inside a step boundary and gates on the step returning null, but
 * `loadBookingHorizonDays` catches its own error and returns the default, so the
 * step never failed, the gate never opened, and the lane was already measuring
 * against a guessed horizon while reading as if it refused to (L109).
 *
 * Null means the READ failed, never "no override is stored". A row that reads
 * fine with a null `horizon_days` is the documented fall through to the env value
 * and then the coded default, which is a real answer; collapsing the two would
 * make every org that never set an override unmeasurable (L214).
 */
export async function readBookingHorizonDays(): Promise<number | null> {
  try {
    const db = supabaseAdmin();
    const row = unwrap(
      await db.from("booking_settings").select("horizon_days").eq("id", 1).maybeSingle(),
      "booking_settings.horizon_days",
    ) as Pick<BookingSettings, "horizon_days"> | null;
    return resolveHorizonDays(row?.horizon_days ?? null, envHorizon(), HORIZON_DEFAULT);
  } catch (err) {
    log.error("booking-settings", { msg: "horizon read failed" }, err);
    return null;
  }
}

/**
 * The line at which Team capacity flags a day nearly full (#3936, migration 0192), or
 * **null** when the read failed. Never the default in place of a failed read: a page
 * flagging days against a line nobody read would look exactly like one that read it.
 */
export async function readNearlyFullPct(): Promise<number | null> {
  try {
    const db = supabaseAdmin();
    const row = unwrap(
      await db.from("booking_settings").select("capacity_nearly_full_pct").eq("id", 1).maybeSingle(),
      "booking_settings.capacity_nearly_full_pct",
    ) as Pick<BookingSettings, "capacity_nearly_full_pct"> | null;
    // No row is the column default, a real answer: the row is created on the first save.
    return row?.capacity_nearly_full_pct ?? NEARLY_FULL_DEFAULT_PCT;
  } catch (err) {
    log.error("booking-settings", { msg: "nearly full line read failed" }, err);
    return null;
  }
}

/**
 * The column default in migration 0192, for an org whose settings row does not exist yet. Held to
 * the migration's own default by scripts/test-team-capacity-copy.ts, so the two cannot drift.
 */
export const NEARLY_FULL_DEFAULT_PCT = 85;

/**
 * The resolved horizon for the BOOKING path, which degrades deliberately.
 *
 * Unlike getDefaultBucketCode (which throws on a read error, because a false "no
 * default" is dangerous), a config read error here falls back to the coded
 * default: booking must keep working with the standard window rather than
 * collapse, and serving the standard window is a correct thing to do, not a
 * measurement anybody will draw a conclusion from.
 *
 * That is the whole difference from `readBookingHorizonDays`, and the fallback is
 * written here ONCE so the choice is visible at the site that makes it rather
 * than repeated at each caller. Anything that measures against the window must
 * use the nullable read instead.
 */
export async function loadBookingHorizonDays(): Promise<number> {
  const read = await readBookingHorizonDays();
  return read ?? resolveHorizonDays(null, envHorizon(), HORIZON_DEFAULT);
}

/**
 * Direct-booking settings (#1015, migration 0086). A single-row config table
 * (id pinned to 1), server-read via the secret-key admin client.
 *
 * `default_bucket_code` is the bucket a keyed direct-booking caller falls back to
 * when it passes no XBC. A null return means "no default configured" (the caller
 * decides what that means: the #1017 bookable endpoint answers 400 NO_DEFAULT_BUCKET,
 * fail-loud). We deliberately do NOT swallow a read error into null: a genuine DB
 * error (e.g. a missing column mid-migration) would otherwise masquerade as an
 * intentional "no default", so it flows through `unwrap` and throws instead.
 */
export interface DefaultBucketPayload {
  default_bucket_code: string | null;
  errors: string[];
}

/**
 * Parse + validate the admin settings form's default-bucket selection (#1016).
 * Blank clears the default (explicit null). A non-blank value must be one of
 * `validCodes` (the current non-test bucket codes); anything else is refused with
 * an error so the action never persists a code that points at no bucket (which
 * would surface later as a confusing NO_DEFAULT-adjacent failure at book time).
 * Pure so it is node/vitest-testable without a DB.
 */
export function parseDefaultBucketForm(raw: string, validCodes: Set<string>): DefaultBucketPayload {
  const code = (raw ?? "").trim();
  if (code === "") return { default_bucket_code: null, errors: [] };
  if (!validCodes.has(code)) {
    return {
      default_bucket_code: null,
      errors: [`"${code}" is not a current bucket code. Pick one from the list.`],
    };
  }
  return { default_bucket_code: code, errors: [] };
}

export async function getDefaultBucketCode(): Promise<string | null> {
  const db = supabaseAdmin();
  const row = unwrap(
    await db.from("booking_settings").select("default_bucket_code").eq("id", 1).maybeSingle(),
    "booking_settings.default_bucket_code",
  ) as Pick<BookingSettings, "default_bucket_code"> | null;
  const code = row?.default_bucket_code?.trim();
  return code ? code : null;
}

/**
 * Is Slate still taking public bookings? (#2297, migration 0122.)
 *
 * Read PER REQUEST and deliberately not cached: the switch's whole value is that it
 * takes effect in seconds without a deploy, and any TTL is the delay somebody would
 * be staring at while a bad booking went through. The cost is one single-row primary
 * key read on a path that already makes several, and only on the write.
 *
 * **Null means the read FAILED**, never "no pause is stored". A settings row that is
 * absent entirely is a real answer, not a failure: nobody has ever paused bookings,
 * so bookings are open. Collapsing the two would hand the gate the benign value on
 * exactly the fault it exists to survive, which is the #277 shape this repo has
 * shipped before. `judgePublicBooking` is what decides what null then does, and it
 * refuses; the reasoning for failing closed lives there and in its test.
 */
export async function readPublicBookingPaused(): Promise<boolean | null> {
  try {
    const db = supabaseAdmin();
    const row = unwrap(
      await db.from("booking_settings").select("public_booking_paused").eq("id", 1).maybeSingle(),
      "booking_settings.public_booking_paused",
    ) as Pick<BookingSettings, "public_booking_paused"> | null;
    return row?.public_booking_paused === true;
  } catch (err) {
    log.error("booking-settings", { msg: "public booking pause read failed" }, err);
    return null;
  }
}

/**
 * Is the reroute-on-ineligibility trigger armed? (#3582, migration 0179.)
 *
 * The go-live switch for the automatic demotion reroute. Read once per hourly roster run.
 *
 * It gates a customer-MOVING action, so an unreadable switch is never read as "on". An absent
 * settings row is a real answer (nobody has armed it) and is off. A read ERROR answers **null**,
 * never throwing: the sync treats it as off and moves nobody, AND reports it (#3615). It used to
 * answer false, which is also what a deliberately OFF switch answers, so a switch that could not
 * be read once armed would have checked nobody every hour while looking exactly like a quiet one.
 */
export async function readDemotionRerouteEnabled(): Promise<boolean | null> {
  try {
    const db = supabaseAdmin();
    const row = unwrap(
      await db.from("booking_settings").select("demotion_reroute_enabled").eq("id", 1).maybeSingle(),
      "booking_settings.demotion_reroute_enabled",
    ) as Pick<BookingSettings, "demotion_reroute_enabled"> | null;
    return row?.demotion_reroute_enabled === true;
  } catch (err) {
    log.error("booking-settings", { msg: "demotion reroute flag read failed, treating as off" }, err);
    return null;
  }
}

/**
 * May a coordinator place a call on the placeholder advisor? (#4200, migration 0207.)
 *
 * The go live switch for placeholder bookings, read on every coordinator booking. It
 * lets a call stack on the placeholder, so an unreadable switch is never read as "on".
 * An absent settings row is a real answer (nobody has turned it on) and is off. A read
 * ERROR answers **null**, never throwing, so the booking path can refuse it by name
 * rather than read it as a switch somebody left off.
 */
export async function readPlaceholderBookingEnabled(): Promise<boolean | null> {
  try {
    const db = supabaseAdmin();
    const row = unwrap(
      await db.from("booking_settings").select("placeholder_booking_enabled").eq("id", 1).maybeSingle(),
      "booking_settings.placeholder_booking_enabled",
    ) as Pick<BookingSettings, "placeholder_booking_enabled"> | null;
    return row?.placeholder_booking_enabled === true;
  } catch (err) {
    log.error("booking-settings", { msg: "placeholder booking switch read failed, treating as unreadable" }, err);
    return null;
  }
}

/**
 * The kill switch AND when it was last thrown, for the monitor lane (#2366).
 *
 * A deliberate second read rather than a widening of `readPublicBookingPaused`
 * above, and the difference is the error handling rather than the columns. That one
 * is on the booking hot path, must never throw, and answers null so the gate can
 * fail closed. This one is a monitor read: it THROWS on a read error, so the lane's
 * own step boundary reports it under `monitor_step_failing` and the check reports
 * `unreadable` rather than a silence indistinguishable from a healthy switch (L98).
 *
 * An ABSENT row is a real answer, not a failure: nobody has ever paused bookings, so
 * bookings are running.
 */
export async function readPublicBookingPauseState(): Promise<{
  paused: boolean;
  /** Epoch ms the switch was last set to stopped, or null while it is running (and
   *  for a paused row whose stamp predates migration 0132). */
  sinceMs: number | null;
}> {
  const db = supabaseAdmin();
  const row = unwrap(
    await db
      .from("booking_settings")
      .select("public_booking_paused,public_booking_paused_at")
      .eq("id", 1)
      .maybeSingle(),
    "booking_settings.public_booking_paused_at",
  ) as Pick<BookingSettings, "public_booking_paused" | "public_booking_paused_at"> | null;
  const paused = row?.public_booking_paused === true;
  // parseStampMs, never Date.parse: an unreadable stamp must arrive as "nothing
  // recorded when" rather than as a NaN every comparison reads as under the
  // threshold, which would silence the notice forever (#1169).
  const sinceMs = paused ? parseStampMs(row?.public_booking_paused_at) : null;
  return { paused, sinceMs };
}
