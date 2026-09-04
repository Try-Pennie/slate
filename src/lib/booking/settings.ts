import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { BookingSettings } from "@/lib/db/types";

/**
 * Org-wide booking horizon (#216, folds in audit AUD-076). Precedence store > env >
 * coded default, mirroring loadMonitorSettings.
 *
 * Counts BOOKABLE days, not calendar days (#1326): how many days a lead is offered
 * to choose from. A closed day inside the run does not use one up, so the furthest
 * date reaches beyond this number, and the window actually computed is
 * `searchWindowDays(horizon)` in `availability/bookable-days.ts`.
 *
 * Nothing enforces this as a booking LIMIT. There is no horizon check on the write
 * path, so a key-authed caller can book past it; this only shapes what is computed
 * and offered. Widening it therefore cannot let anyone book something they could
 * not book before.
 *
 * The cap is 7 for now; 14 is deferred pending a 200-agent load-soak, because
 * per-bucket recompute cost is ~super-linear in the window and the recompute lane
 * is tuned for a small one. The search allowance is small for the same reason.
 */
export const HORIZON_DEFAULT = 4;
export const HORIZON_MIN = 1;
export const HORIZON_MAX = 7;

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

export interface HorizonFormPayload {
  horizon_days: number | null;
  errors: string[];
}

/**
 * Parse + validate the admin settings form's horizon field. A value must be a
 * whole number within range; anything else is refused with an error so the action
 * never persists a nonsense horizon. Pure so it is node/vitest-testable without a DB.
 *
 * BLANK IS REFUSED (#1924). Dan: "we shouldn't allow it to be blank. we should
 * require a number and the default should still be 4. if they try to save with no
 * number, just error and don't let them." It used to clear the override, and the
 * field rendered empty with 4 only as a placeholder, so an admin who saved without
 * typing wrote null while a grey 4 sat in the box looking like a value.
 *
 * THE READER'S FALLBACK STAYS, deliberately, and the two layers now say different
 * things: this FORM refuses blank, and `readBookingHorizonDays` still tolerates a
 * null row. `horizon_days` is nullable and null rows exist, so removing that
 * fallback because "the form no longer allows null" would turn a data state that
 * is still there into a booker offering nothing. Do not consolidate them.
 */
export function parseHorizonForm(raw: string): HorizonFormPayload {
  const t = (raw ?? "").trim();
  if (t === "") {
    return {
      horizon_days: null,
      errors: [`Enter how many days a lead is offered, between ${HORIZON_MIN} and ${HORIZON_MAX}.`],
    };
  }
  const n = Number(t);
  if (!Number.isInteger(n) || n < HORIZON_MIN || n > HORIZON_MAX) {
    return {
      horizon_days: null,
      errors: [`Booking horizon must be a whole number of days between ${HORIZON_MIN} and ${HORIZON_MAX}.`],
    };
  }
  return { horizon_days: n, errors: [] };
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
