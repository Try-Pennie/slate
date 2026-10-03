import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { refuseCronSecret } from "@/lib/bearer-failure";
import { acquireLock, releaseLock } from "@/lib/locks";
import { purgeSnowflakeErasure } from "@/lib/snowflake/purge";
import { log } from "@/lib/log";

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
 * WHO MAY CALL IT: an operator process holding CRON_SECRET, and nothing else
 * (#1961). The signed-in admin path went with the buttons on 2026-09-06: with no
 * control on the page, a session that could still reach this endpoint would be
 * the same easy purge Dan asked to remove, one fetch away from the console
 * instead of one click. It is a TIGHTENING, and it loses no attribution, because
 * the operator path is refused outright unless it names who authorised the
 * erasure, which is a better record than an actor id: it says who ASKED, not who
 * typed.
 * WHAT IT MAY TOUCH: only bookings that already appear in a `pii.erasure` audit
 * row, i.e. bookings whose contact data has ALREADY been erased in Supabase, so
 * blanking the warehouse copy is by definition the outcome that was requested. An
 * id outside that trail is refused (400), never purged. It only ever nulls contact
 * columns; the export role holds no DELETE, so nothing here can drop a row.
 *
 * POST, not GET, so it cannot be triggered by following a link, and it takes a
 * lock so two operators cannot run it concurrently. The body is REQUIRED and
 * must carry `authorisedBy` (#1961): a purge with nobody attached to it is
 * refused before the lock. `bookingIds` inside it narrows the run to a subset;
 * omitting it purges every booking in the trail, which is safe to repeat. Note repeating it is idempotent in
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
  // #1046's same-origin refusal is GONE with the session path (#1961). It exists
  // for an AMBIENT credential, one a browser attaches on its own: a cookie can be
  // ridden by another origin, a secret in a header cannot. With the only caller
  // holding CRON_SECRET there is no cross-site request to refuse, and keeping the
  // check would put a browser-shaped rule on a machine caller, refusing an
  // operator whose tool happened to send an Origin header.
  // An operator secret and nothing else (#1961). A signed-in admin is refused
  // here like anybody else: that is the whole point of taking the buttons off.
  if (!isAuthorizedCron(req)) {
    return refuseCronSecret(req.headers, () => NextResponse.json({ error: "forbidden" }, { status: 403 }));
  }

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

  // #1961: a purge must say who authorised it.
  //
  // The operator path records no `actorId`, because there is no signed-in user
  // behind it, and since the buttons went it is the only path. An entry naming
  // nobody would be the entire record of a compliance action (L529), and the one
  // real purge in this system's history is exactly that: 2026-07-31, eight rows
  // blanked, verified clean, and no actor and no authoriser on the row.
  //
  // Refused rather than defaulted: a default here would be a name nobody chose,
  // attached to an irreversible deletion, and it would read in the trail exactly
  // like a real one.
  if (!authorisedBy) {
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
    const result = await purgeSnowflakeErasure(bookingIds, undefined, authorisedBy);
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


