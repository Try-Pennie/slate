// Read-only check for #1486. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/verify-imported-timeoff-cover.ts
//
// WHAT IT ANSWERS. Nine approved time off periods still ahead of us were
// imported from the old Apps Script tool: Slate never ran a step for them, so it
// holds no calendar event id and no recorded outcome, and the protection page
// (#1485) deliberately excludes them. Whether those agents are ACTUALLY free to
// be booked during their own time off is a different question, and the only
// honest answer comes from Google.
//
// WHY busy_blocks CANNOT ANSWER IT. That table is a cache fed by the sync
// rotation, which only runs for bookable agents, and the roster is dark before
// cutover (#1272). So an empty busy_blocks for these people says nothing about
// their real calendars: it is the absence of a sync, not the absence of an
// event (L58, do not verify a system against records it wrote itself).
//
// It talks to LIVE Google and is deliberately not named `test-*.ts` (that glob
// is the offline unit suite). It WRITES NOTHING, anywhere: no calendar, no
// database, no alert. Its output is a list for a person to act on.
//
// Needs the Google service-account creds (GOOGLE_SA_CLIENT_EMAIL /
// GOOGLE_SA_PRIVATE_KEY) and the Supabase secret key in .env.local / .dev.vars.
import { loadEnvFiles } from "./smoke-env.ts";

loadEnvFiles([".env.local", ".dev.vars"]);

const { supabaseAdmin } = await import("@/lib/supabase/admin");
const { freeBusyMany } = await import("@/lib/google/calendar");
// The SAME predicate the monitor judges with, fed Google's answer instead of the
// cache, so this cannot quietly disagree with the page about what "covered"
// means (L107). A second implementation here would drift in whichever direction
// flattered the conclusion.
const { unprotectedTimeOff, slateActedOn } = await import("@/lib/monitor/ooo-protection");

type Row = {
  id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  agent_event_id: string | null;
  side_effects: Record<string, string> | null;
};

const db = supabaseAdmin();
const nowIso = new Date().toISOString();

const { data, error } = await db
  .from("ooo_requests")
  // cap-safe: approved requests whose window has not ended, tens of rows.
  .select("id, user_id, starts_at, ends_at, agent_event_id, side_effects")
  .eq("status", "approved")
  .gte("ends_at", nowIso)
  .order("starts_at", { ascending: true });
if (error) {
  console.error(`FAILED: could not read ooo_requests: ${error.message}`);
  process.exit(1);
}

// The monitor's OWN exclusion predicate, so this reports on exactly the set the
// page is silent about rather than a hand-written approximation of it (L107).
const imported = ((data ?? []) as Row[]).filter(
  (r) =>
    !slateActedOn({
      id: r.id,
      userId: r.user_id,
      agentName: null,
      agentEmail: null,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      displayTzId: "Etc/UTC",
      displayTzLabel: null,
      agentEventId: r.agent_event_id,
      busyBlockEffect: r.side_effects?.busy_block ?? null,
      agentEventEffect: r.side_effects?.agent_event ?? null,
    }),
);

if (imported.length === 0) {
  console.log("No imported approved time off is still ahead of us. Nothing to check.");
  process.exit(0);
}

const userIds = [...new Set(imported.map((r) => r.user_id))];
const { data: users, error: userErr } = await db
  .from("users")
  // cap-safe: primary-key lookup of the few agents involved.
  .select("id, email, name, bookable, deactivated_at")
  .in("id", userIds);
if (userErr) {
  console.error(`FAILED: could not read users: ${userErr.message}`);
  process.exit(1);
}
const byId = new Map(
  ((users ?? []) as { id: string; email: string; name: string | null; bookable: boolean; deactivated_at: string | null }[]).map(
    (u) => [u.id, u],
  ),
);

console.log(
  `Checking ${imported.length} imported approved period(s) against Google, read only.\n`,
);

let covered = 0;
let open = 0;
let unreadable = 0;

for (const r of imported) {
  const u = byId.get(r.user_id);
  if (!u) {
    console.log(`${r.id}  UNKNOWN AGENT (user ${r.user_id} is gone)`);
    unreadable++;
    continue;
  }
  let busy: { start: string; end: string }[];
  try {
    // Read as the agent's own identity over their own primary calendar, one call
    // per period. Domain free/busy is cross-visible, so this needs no special
    // account beyond the delegation Slate already uses.
    const res = await freeBusyMany(u.email, r.starts_at, r.ends_at, [u.email]);
    const entry = res.get(u.email);
    if (!entry || entry.error) throw new Error("Google reported an error for this calendar");
    busy = entry.busy;
  } catch (e) {
    // A calendar we cannot read is reported as exactly that, never scored as
    // clear: "could not check" and "nothing is blocking it" are different
    // answers and only one of them is safe to act on (L11).
    // The machine reason, not the whole body: a 403 that means "this account has
    // never been given Calendar" (#1396) and a 403 that means "no access" need
    // different people doing different things.
    const reason =
      /"reason"\s*:\s*"([^"]+)"/.exec(String(e))?.[1] ?? String(e).slice(0, 80);
    console.log(`${r.id}  ${u.email}  COULD NOT READ: ${reason}`);
    unreadable++;
    continue;
  }
  // Does Google's own answer cover the whole window? Asked of the monitor's own
  // judge, with Google's busy periods standing in for the cache and the window
  // anchored at its own start so a period already under way is judged whole.
  const stillOpen = unprotectedTimeOff(
    [
      {
        id: r.id,
        userId: r.user_id,
        agentName: u.name,
        agentEmail: u.email,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        displayTzId: "Etc/UTC",
        displayTzLabel: null,
        agentEventId: null,
        // Marks it as one to judge rather than one to skip: here we are asking
        // the question the page deliberately does not ask about these rows.
        busyBlockEffect: "ok",
        agentEventEffect: null,
      },
    ],
    busy.map((b) => ({ userId: r.user_id, startsAt: b.start, endsAt: b.end })),
    Date.parse(r.starts_at),
  );
  const whole = stillOpen.length === 0;
  const flag = whole ? "BLOCKED" : "OPEN";
  if (whole) covered++;
  else open++;
  const who = u.name?.trim() || u.email;
  const pool = u.deactivated_at ? "deactivated" : u.bookable ? "bookable" : "not bookable";
  console.log(
    `${r.id}  ${who} (${pool})  ${r.starts_at} to ${r.ends_at}  ${flag}` +
      `  [${busy.length} busy period(s) reported]`,
  );
}

console.log(
  `\n${covered} fully blocked on Google, ${open} open, ${unreadable} could not be read.`,
);
if (open > 0) {
  console.log(
    "\nThe open ones are approved time off with nothing blocking it, on Google or in Slate.\n" +
      "At cutover a lead can be booked into those hours. Deciding what to write there is\n" +
      "a separate step and needs a person: this script writes nothing.",
  );
}
