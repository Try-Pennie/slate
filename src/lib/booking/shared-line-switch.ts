import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { BookingSettings } from "@/lib/db/types";
import { makeSharedLineSwitchReader, type SharedLineDefaultProblem } from "@/lib/booking/shared-line-switch-core";
import {
  makeSwitchReadFailureReporter,
  SWITCH_READ_ALERT_KEY,
  SWITCH_READ_ALERT_COOLDOWN_MS,
} from "@/lib/booking/shared-line-switch-alert";
import { afterResponse } from "@/lib/after-response";
import { sendThrottledAlert } from "@/lib/notify/dispatch";
import { isWorkersRuntime } from "@/lib/platform/runtime";
import { parseStampMs } from "@/lib/date/stamp";
import type { SharedLineSwitchHistory } from "@/lib/monitor/shared-line-left-off";

/**
 * The shared confirm line's switch, wired to the real database and the deployment's vars
 * (#3325). The decisions (the TTL, the deadline, what a failed read answers, what the
 * default means) live in `shared-line-switch-core.ts`, which is re-exported here so a
 * server caller has one place to import the switch from. Client code imports the core
 * directly, because this module reads the database.
 *
 * Not yet consulted by the booking path: the confirm path takes it through `BookingDeps`
 * in the change that adds the shared line itself.
 */
export * from "@/lib/booking/shared-line-switch-core";
export { SWITCH_READ_PAGE_AFTER, SWITCH_READ_ALERT_COOLDOWN_MS } from "@/lib/booking/shared-line-switch-alert";

/** The stored switch, read once. THROWS on a failed read; each caller decides what that means. */
async function readSharedConfirmLineColumn(): Promise<boolean> {
  const row = unwrap(
    await supabaseAdmin().from("booking_settings").select("shared_confirm_line").eq("id", 1).maybeSingle(),
    "booking_settings.shared_confirm_line",
  ) as Pick<BookingSettings, "shared_confirm_line"> | null;
  // An absent settings row is a real answer: nobody has ever turned the line on.
  return row?.shared_confirm_line === true;
}

/** The deployment default's problem in words, naming the setting so a reader can find it. */
function defaultProblemMessage(problem: SharedLineDefaultProblem): string {
  const consequence =
    "so an isolate that cannot read the shared confirm line switch treats the line as off";
  return problem.kind === "missing"
    ? `SHARED_CONFIRM_LINE_DEFAULT is not set, ${consequence}`
    : `SHARED_CONFIRM_LINE_DEFAULT is neither on nor off, ${consequence}`;
}

/**
 * #3339: every failed read is logged, counted on this isolate, and a sustained run pages
 * (`shared-line-switch-alert.ts`). One reporter per isolate, so its window counts this
 * isolate's failures. The page goes after the response, so a failing database costs the
 * confirm nothing more than the read it already lost.
 */
const reportReadFailure = makeSwitchReadFailureReporter({
  now: () => Date.now(),
  onWorkers: isWorkersRuntime,
  log: (fields, err) => log.warn("shared-line", fields, err),
  page: (text) =>
    afterResponse("shared-line-switch-alert", () =>
      // alert-key: shared_line_switch_unreadable
      // alert-text-ok: our own copy from shared-line-switch-alert.ts, built from a count and
      // the deployment default; the raw error goes to the log line above, never here.
      sendThrottledAlert(SWITCH_READ_ALERT_KEY, SWITCH_READ_ALERT_COOLDOWN_MS, text).catch((err) => {
        log.error("shared-line", { msg: "alert failed" }, err);
      }),
    ),
  deploymentDefault: () => process.env.SHARED_CONFIRM_LINE_DEFAULT,
});

/**
 * Is the shared confirm line on? One read per isolate per `SHARED_LINE_SWITCH_TTL_MS`,
 * answering where the answer came from (`read`, `last-known` or `default`) so the
 * confirm path can log it.
 */
export const readSharedConfirmLine = makeSharedLineSwitchReader({
  read: readSharedConfirmLineColumn,
  now: () => Date.now(),
  // Read per call, never at module load: on Workers the deployment's vars are assigned
  // into process.env by the OpenNext wrapper, after modules can already have loaded.
  rawDefault: () => process.env.SHARED_CONFIRM_LINE_DEFAULT,
  onReadError: reportReadFailure,
  onDefaultProblem: (problem) =>
    log.warn("shared-line", {
      msg: defaultProblemMessage(problem),
      value: problem.kind === "unrecognised" ? problem.raw : null,
    }),
});

/**
 * The switch as the admin page draws it: fresh, never cached, and null when it could
 * not be read, because "could not tell whether the line is shared" is a different
 * screen from either answer (L530).
 */
export async function readSharedConfirmLineSetting(): Promise<boolean | null> {
  try {
    return await readSharedConfirmLineColumn();
  } catch (err) {
    log.error("shared-line", { msg: "shared confirm line switch unreadable on the admin page" }, err);
    return null;
  }
}

/** One `booking.settings` audit entry that flipped the switch, as the history read needs it. */
interface SwitchFlip {
  chain_seq: number;
  created_at: string;
}

/**
 * The switch and WHEN it was last activated, for the monitor lane's left off check
 * (#3339, `src/lib/monitor/shared-line-left-off.ts`). THROWS on any failed read, so the
 * step boundary reports it rather than a failure reading as "never switched on" (L98).
 *
 * The record of activation is the audit trail the admin action writes on every flip
 * (`booking.settings`, `{ shared_confirm_line: true | false }`), immutable since migration
 * 0089, ordered by its hash chain position rather than by time, since the chain is the one
 * order every row is guaranteed to have. Read only while the switch is off: while it is
 * on there is nothing to time. Each read is one row (`.limit(1)`), the newest on, then the
 * FIRST off after it, so pressing off twice cannot restart the clock.
 */
export async function readSharedLineSwitchHistory(): Promise<SharedLineSwitchHistory> {
  if (await readSharedConfirmLineColumn()) return { on: true, lastOnAtMs: null, offSinceMs: null };
  const db = supabaseAdmin();
  const lastOn = (
    unwrap(
      await db
        .from("audit_log")
        .select("chain_seq, created_at")
        .eq("action", "booking.settings")
        .eq("details->>shared_confirm_line", "true")
        .order("chain_seq", { ascending: false })
        .limit(1),
      "audit_log shared confirm line switched on",
    ) as SwitchFlip[] | null
  )?.[0];
  if (!lastOn) return { on: false, lastOnAtMs: null, offSinceMs: null };
  const firstOff = (
    unwrap(
      await db
        .from("audit_log")
        .select("chain_seq, created_at")
        .eq("action", "booking.settings")
        .eq("details->>shared_confirm_line", "false")
        .gt("chain_seq", lastOn.chain_seq)
        .order("chain_seq", { ascending: true })
        .limit(1),
      "audit_log shared confirm line switched off",
    ) as SwitchFlip[] | null
  )?.[0];
  // An unreadable activation stamp is not "never activated": the row says somebody turned
  // it on, so a stamp that cannot be read counts as long ago, which errs toward asking
  // (parseStampMs, never Date.parse, #1169).
  const lastOnAtMs = parseStampMs(lastOn.created_at) ?? 0;
  return { on: false, lastOnAtMs, offSinceMs: firstOff ? parseStampMs(firstOff.created_at) : null };
}
