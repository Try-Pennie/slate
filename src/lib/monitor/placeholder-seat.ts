/**
 * The placeholder advisor's Google seat failing, and no usable placeholder while the go
 * live switch is on (#4206, Phase 8 of milestone 75).
 *
 * Every call placed on the placeholder (Marcia) sends its invite from the placeholder's
 * own Google Calendar and its 24 hour reminder from its own Gmail. The placeholder is
 * never bookable, so every advisor health path skips it on purpose (the sync lanes read
 * `bookable`, the activation gate never runs for it): if its seat breaks, nothing else
 * says so, and calls go on being placed whose customers get neither an invite nor a
 * reminder.
 *
 * TWO PROBES, both read only, both classified by the one vocabulary every Google check
 * uses (`Reachability`, `src/lib/google/reachability-classify.ts`):
 *
 *   calendar  `calendarList.list` through domain wide delegation, the activation gate's
 *             own probe (`classifyCalendarReachability`), which hits Google every time.
 *   gmail     minting the `gmail.send` token for the seat. Send is the only Gmail scope
 *             Slate holds, and it reads nothing, so the mint is the read only probe that
 *             exists: it proves the account is in the Workspace and delegation still
 *             grants the scope. A token minted in the last hour answers from the cache,
 *             so a Gmail grant revoked between mints is seen within about an hour. What
 *             it cannot see is Gmail switched off for the user (that fails only at a
 *             send, and `booking_reminders_failing` reports those) or the vacation
 *             responder: reading `users.settings.getVacation` needs
 *             `gmail.settings.basic` (or `gmail.readonly`), which Slate does not hold and
 *             this does not add.
 *
 * WHEN IT SPEAKS. Never by comparing a kind with the gone one (AGENTS.md): `isDefinitiveFailure`
 * splits the kinds. A failing tick bumps one streak; a definitive failure on either probe
 * pages on the second failing tick in a row, a transient one only on the fourth (twenty
 * minutes, the lane's own step failure bound), because a transient blip usually heals.
 * One measured healthy tick, both probes answering, clears the streak and posts the all
 * clear. A read that fails measures nothing and clears nothing.
 *
 * IN USE. The seat is checked while the switch is on, or while any call still sits on
 * the placeholder from now on (its reminders still go out from that seat). A seat in use
 * by neither is not checked, and a page open about it closes as a stand down that says
 * nothing was fixed.
 *
 * NO USABLE PLACEHOLDER (`placeholder_missing`). With the switch on, a coordinator whose
 * customer finds no free advisor is refused ("no placeholder advisor to hold the call"),
 * so the switch says calls can be placed when none can. No row, a deactivated row and a
 * row with no address each refuse the booking for a different reason and are named
 * apart (L11). While the switch is off it says nothing, and a page open about it closes
 * as switched off rather than as fixed.
 *
 * Pure apart from the injected reads, probes, streak and dispatcher, so the node suite
 * drives every branch (scripts/test-placeholder-seat.ts).
 */
import { isDefinitiveFailure, type FailureKind } from "../google/sync-health.ts";
import { logAlertSendFailure, logResolveFailure } from "../notify/send-failure.ts";
import type { AlertResolve, ThrottledNotify } from "./alert-deps.ts";

export const PLACEHOLDER_SEAT_KEY = "placeholder_seat_failing";
export const PLACEHOLDER_MISSING_KEY = "placeholder_missing";

/** The consecutive failing ticks counter, kept apart from the alert key. */
export const PLACEHOLDER_SEAT_STREAK_KEY = `streak:${PLACEHOLDER_SEAT_KEY}`;

/** Failing ticks in a row before a definitive failure pages. */
export const PLACEHOLDER_SEAT_DEFINITIVE_TICKS = 2;
/** Failing ticks in a row before a transient one does: twenty minutes on a five minute lane. */
export const PLACEHOLDER_SEAT_TRANSIENT_TICKS = 4;
/**
 * The fixed window the streak is counted in, twice the longer streak so a late tick never
 * splits a genuine run in two (the step failure streak's rule, `step-failure.ts`).
 */
export const PLACEHOLDER_SEAT_STREAK_WINDOW_S = 2 * PLACEHOLDER_SEAT_TRANSIENT_TICKS * 5 * 60;

export type SeatProbe = FailureKind | "reachable";
export type SeatSurface = "calendar" | "gmail";

/** A placeholder row, as this check reads it. */
export interface PlaceholderSeatRow {
  id: string;
  name: string | null;
  email: string | null;
  deactivated_at: string | null;
}

export interface SeatFailure {
  email: string;
  surface: SeatSurface;
  kind: FailureKind;
}

/** Why no placeholder can take a call, or null when one can. */
export type MissingReason = "no-row" | "deactivated" | "no-address";

export function missingReason(rows: PlaceholderSeatRow[]): MissingReason | null {
  if (rows.some(usable)) return null;
  if (rows.length === 0) return "no-row";
  if (rows.some((r) => r.deactivated_at !== null)) return "deactivated";
  return "no-address";
}

function usable(r: PlaceholderSeatRow): boolean {
  return r.deactivated_at === null && (r.email ?? "").trim() !== "";
}

// ------------------------------------------------------------------- copy

const KIND_WORDS: Record<FailureKind, string> = {
  gone:
    "was refused (a credential or membership repair: the account was removed from the Workspace, " +
    "or domain wide delegation no longer grants it)",
  "not-provisioned": "was refused because the account has no Calendar (a Workspace admin has to give it Calendar)",
  transient: "did not answer (a timeout, a rate limit or a Google outage, which usually heals)",
};

const SURFACE_WORDS: Record<SeatSurface, string> = {
  calendar: "its Google Calendar",
  gmail: "its Gmail sending",
};

/** The page. Which seat, which surface, which kind, what it costs, and what to do. */
export function formatPlaceholderSeatAlert(failures: SeatFailure[]): string {
  const emails = [...new Set(failures.map((f) => f.email))];
  const parts = failures.map((f) => `${SURFACE_WORDS[f.surface]} ${KIND_WORDS[f.kind]}`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join("; ")}; and ${parts[parts.length - 1]}`;
  const definitive = failures.some((f) => isDefinitiveFailure(f.kind));
  return (
    `The placeholder advisor's Google seat (${emails.join(", ")}) is failing: ${list}. ` +
    `Calls placed on the placeholder still book, but their invites and 24 hour reminders go out from ` +
    `this seat, so those customers may get neither. ` +
    (definitive
      ? `Retrying will not fix it: repair the account in Google Workspace, or switch placing calls on the ` +
        `placeholder off until it is fixed.`
      : `If it is still failing in an hour, check Google's status page and the service account's delegation.`)
  );
}

export function formatPlaceholderSeatRecovery(emails: string[]): string {
  return `The placeholder advisor's Google seat (${emails.join(", ")}) answers again: its calendar and its Gmail sending both work.`;
}

export const PLACEHOLDER_SEAT_STOOD_DOWN =
  "Placing calls on the placeholder is switched off and no call sits on it, so its Google seat is no " +
  "longer checked. Nothing was fixed: check the seat before switching placing calls back on.";

const MISSING_WORDS: Record<MissingReason, string> = {
  "no-row": "there is no placeholder advisor at all",
  deactivated: "the placeholder advisor is deactivated",
  "no-address": "the placeholder advisor has no email address, so no invite can be sent from it",
};

export function formatPlaceholderMissingAlert(reason: MissingReason): string {
  return (
    `Placing calls on the placeholder is switched on, but ${MISSING_WORDS[reason]}. Every customer a ` +
    `coordinator books while no advisor is free is refused. Restore the placeholder advisor, or switch ` +
    `placing calls on the placeholder off.`
  );
}

export const PLACEHOLDER_MISSING_RECOVERY = "A usable placeholder advisor exists again, so calls can be placed on it.";

export const PLACEHOLDER_MISSING_SWITCHED_OFF =
  "Placing calls on the placeholder was switched off, so its missing advisor no longer refuses anyone. " +
  "Nothing was fixed: restore the placeholder advisor before switching it back on.";

// ----------------------------------------------------------------- runner

export type PlaceholderSeatResult =
  /** The switch, the placeholder rows or the calls on it could not be read. */
  | { status: "unreadable"; error: string }
  | {
      status: "checked";
      switchOn: boolean;
      futureCalls: number;
      missing: MissingReason | null;
      /** Not in use, or no usable seat to probe: either way not probed. */
      seat: "not-in-use" | "no-seat" | "healthy" | "failing";
      failures: SeatFailure[];
      /** Whether this tick's failures were handed to the dispatcher. */
      paged: boolean;
    };

export interface PlaceholderSeatDeps {
  /** `booking_settings.placeholder_booking_enabled`; null when unreadable (never throws). */
  readSwitch: () => Promise<boolean | null>;
  /** The real (non test) placeholder rows, every org. THROWS. */
  loadPlaceholders: () => Promise<PlaceholderSeatRow[]>;
  /** Active calls on these placeholders that have not ended, counted server side. THROWS. */
  countFutureCalls: (placeholderIds: string[]) => Promise<number>;
  /** Never throws: a failure is its classification. */
  probeCalendar: (email: string) => Promise<SeatProbe>;
  probeGmail: (email: string) => Promise<SeatProbe>;
  /** Bump the failing streak and say whether it reached `alertAt`. */
  bumpStreak: (alertAt: number) => Promise<"reached" | "below" | "unknown">;
  clearStreak: () => Promise<void>;
  notify: ThrottledNotify<unknown>;
  /** REQUIRED: both keys are conditions (#1151). */
  resolve: AlertResolve<unknown>;
  cooldownMs: number;
}

export async function runPlaceholderSeatCheck(deps: PlaceholderSeatDeps): Promise<PlaceholderSeatResult> {
  let switchOn: boolean | null;
  let rows: PlaceholderSeatRow[];
  let futureCalls: number;
  try {
    [switchOn, rows] = await Promise.all([deps.readSwitch(), deps.loadPlaceholders()]);
    // The real placeholders' own calls: a test placeholder's never keep the real seat in use.
    futureCalls = rows.length === 0 ? 0 : await deps.countFutureCalls(rows.map((r) => r.id));
  } catch (err) {
    return { status: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
  // An unreadable switch is not "off": off would close pages and stand the seat down.
  if (switchOn === null) return { status: "unreadable", error: "the placeholder booking switch could not be read" };

  // --- no usable placeholder ---
  const missing = missingReason(rows);
  if (switchOn && missing !== null) {
    await deps
      .notify(PLACEHOLDER_MISSING_KEY, deps.cooldownMs, formatPlaceholderMissingAlert(missing), { subjects: [missing] })
      .catch(logAlertSendFailure(PLACEHOLDER_MISSING_KEY));
  } else {
    const text = missing === null ? PLACEHOLDER_MISSING_RECOVERY : PLACEHOLDER_MISSING_SWITCHED_OFF;
    await deps.resolve(PLACEHOLDER_MISSING_KEY, text).catch(logResolveFailure(PLACEHOLDER_MISSING_KEY));
  }

  // --- the seat ---
  const seats = rows.filter(usable);
  const inUse = switchOn || futureCalls > 0;
  if (!inUse) {
    await deps.resolve(PLACEHOLDER_SEAT_KEY, PLACEHOLDER_SEAT_STOOD_DOWN).catch(logResolveFailure(PLACEHOLDER_SEAT_KEY));
    await deps.clearStreak();
    return { status: "checked", switchOn, futureCalls, missing, seat: "not-in-use", failures: [], paged: false };
  }
  if (seats.length === 0) {
    // Nothing to probe: the missing page above says why. Not a measurement of the seat,
    // so a seat page stays as it is.
    return { status: "checked", switchOn, futureCalls, missing, seat: "no-seat", failures: [], paged: false };
  }

  const failures: SeatFailure[] = [];
  for (const seat of seats) {
    const email = seat.email!.trim();
    const [calendar, gmail] = await Promise.all([deps.probeCalendar(email), deps.probeGmail(email)]);
    if (calendar !== "reachable") failures.push({ email, surface: "calendar", kind: calendar });
    if (gmail !== "reachable") failures.push({ email, surface: "gmail", kind: gmail });
  }

  if (failures.length === 0) {
    await deps.clearStreak();
    const emails = seats.map((s) => s.email!.trim());
    await deps.resolve(PLACEHOLDER_SEAT_KEY, formatPlaceholderSeatRecovery(emails)).catch(logResolveFailure(PLACEHOLDER_SEAT_KEY));
    return { status: "checked", switchOn, futureCalls, missing, seat: "healthy", failures, paged: false };
  }

  const definitive = failures.some((f) => isDefinitiveFailure(f.kind));
  const streak = await deps.bumpStreak(definitive ? PLACEHOLDER_SEAT_DEFINITIVE_TICKS : PLACEHOLDER_SEAT_TRANSIENT_TICKS);
  // A definitive failure is held back only because the next tick will count it; with the
  // count unreadable that promise is gone, so it speaks. A transient one stays quiet.
  const speak = streak === "reached" || (streak === "unknown" && definitive);
  if (speak) {
    await deps
      .notify(PLACEHOLDER_SEAT_KEY, deps.cooldownMs, formatPlaceholderSeatAlert(failures), {
        subjects: failures.map((f) => `${f.email}:${f.surface}:${f.kind}`),
        band: definitive ? 2 : 1,
      })
      .catch(logAlertSendFailure(PLACEHOLDER_SEAT_KEY));
  }
  return { status: "checked", switchOn, futureCalls, missing, seat: "failing", failures, paged: speak };
}
