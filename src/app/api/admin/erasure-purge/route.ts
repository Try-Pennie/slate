import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { isAuthorizedCron } from "@/lib/cron";
import { acquireLock, releaseLock } from "@/lib/locks";
import { purgeSnowflakeErasure } from "@/lib/snowflake/purge";
import { log } from "@/lib/log";
import { crossOriginRefusal } from "@/lib/api/same-origin";

export const dynamic = "force-dynamic";

const LOCK_TTL_MS = 120_000;

/**
 * Run the warehouse half of a data-subject erasure (#1128).
 *
 * Until now this was four SQL statements an operator pasted into Snowsight, and
 * #1197 is what that costs: one of them named a column the warehouse does not
 * have, Snowflake rejected it, and the person's data sat in the archive for two
 * days while the runbook's own verify reported success.
 *
 * WHO MAY CALL IT: a signed-in admin, or an operator process holding CRON_SECRET.
 * Both are already trusted with the whole system; there is no self-service path.
 * WHAT IT MAY TOUCH: only bookings that already appear in a `pii.erasure` audit
 * row, i.e. bookings whose contact data has ALREADY been erased in Supabase, so
 * blanking the warehouse copy is by definition the outcome that was requested. An
 * id outside that trail is refused (400), never purged. It only ever nulls contact
 * columns; the export role holds no DELETE, so nothing here can drop a row.
 *
 * POST, not GET, so it cannot be triggered by following a link, and it takes a
 * lock so two operators cannot run it concurrently. Optional body
 * `{ "bookingIds": [...] }` narrows it to a subset; with no body it purges every
 * booking in the trail, which is safe to repeat. Note repeating it is idempotent in
 * EFFECT, not in the counts: the statements are unguarded, so a second run re-nulls
 * already-null columns and reports the same rows changed. Judge a run by the verify,
 * not by `rowsByTable`.
 *
 * 200 with the row counts and the post-purge verify, 409 when a run is already in
 * flight, 400 for an out-of-scope id, 500 when a statement fails. The response's
 * `ok` is true ONLY when the verify measured zero residual everywhere: a purge
 * that ran but left data behind reports false rather than success.
 */
export async function POST(req: NextRequest) {
  // #1046: this route's only credential is the session cookie, so refuse a request
  // that says it came from somewhere else, before the auth check and before the body
  // is read. See src/lib/api/same-origin.ts for why silence is allowed through.
  const crossOrigin = crossOriginRefusal(req, "admin/erasure-purge");
  if (crossOrigin) return crossOrigin;

  const caller = await resolveCaller(req);
  if (!caller) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let bookingIds: string[] | undefined;
  let authorisedBy: string | undefined;
  try {
    const body = (await req.json()) as { bookingIds?: unknown; authorisedBy?: unknown };
    if (typeof body?.authorisedBy === "string" && body.authorisedBy.trim()) {
      authorisedBy = body.authorisedBy.trim().slice(0, 200);
    }
    if (body?.bookingIds !== undefined) {
      if (!Array.isArray(body.bookingIds) || body.bookingIds.some((id) => typeof id !== "string")) {
        return NextResponse.json({ error: "bookingIds must be an array of strings" }, { status: 400 });
      }
      bookingIds = body.bookingIds as string[];
    }
  } catch {
    // No body at all is the normal case: purge everything in the trail.
  }

  // #1961: a purge run on the operator secret must say who authorised it.
  //
  // That path records no `actorId`, because there is no signed-in user behind
  // it. It was tolerable while the UI button was the ordinary route and this was
  // the exception. Dan's call on 2026-09-06 removes the buttons, so this becomes
  // the ONLY way an erasure is executed and an entry naming nobody would be the
  // entire record of a compliance action (L529).
  //
  // Refused rather than defaulted: a default here would be a name nobody chose,
  // attached to an irreversible deletion, and it would read in the trail exactly
  // like a real one.
  if (!caller.actorId && !authorisedBy) {
    return NextResponse.json(
      {
        error:
          "authorisedBy is required when calling with the operator secret: name who asked for this erasure, so the audit entry is not the only record with nobody attached to it",
      },
      { status: 400 },
    );
  }

  const lock = await acquireLock("erasure_warehouse_purge", LOCK_TTL_MS);
  if (!lock) return NextResponse.json({ error: "a purge is already running" }, { status: 409 });

  try {
    const result = await purgeSnowflakeErasure(bookingIds, caller.actorId, authorisedBy);
    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("erasure-purge", { msg: "purge failed", error: message });
    // An out-of-scope booking id is the caller's mistake, not a fault: say so with
    // a 400 so an operator can see they asked for the wrong thing.
    const status = /have not been erased/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  } finally {
    await releaseLock("erasure_warehouse_purge", lock);
  }
}

/**
 * Who is calling: a signed-in admin (recorded as the actor in the audit trail) or
 * an operator process holding the shared secret (no actor). Null when neither, so
 * the caller is resolved exactly once rather than being re-checked per use.
 */
async function resolveCaller(req: NextRequest): Promise<{ actorId?: string } | null> {
  try {
    return { actorId: (await requireAdmin()).id };
  } catch {
    return isAuthorizedCron(req) ? {} : null;
  }
}
