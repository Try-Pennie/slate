import { supabaseAdmin } from "@/lib/supabase/admin";
import { unwrap } from "@/lib/db/result";
import { log } from "@/lib/log";
import type { BookingSettings } from "@/lib/db/types";
import { makeSharedLineSwitchReader, type SharedLineDefaultProblem } from "@/lib/booking/shared-line-switch-core";

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
  onReadError: (err) =>
    log.warn(
      "shared-line",
      { msg: "shared confirm line switch unreadable, answering the last value read, or the deployment default with none" },
      err,
    ),
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
