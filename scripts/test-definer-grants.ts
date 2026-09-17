// #2447: which SECURITY DEFINER functions can the web roles actually execute?
//
// `scripts/test-migration-grants.ts` (#2391) proves that every definer function DEFINED IN
// A MIGRATION revokes EXECUTE from public, anon and authenticated. It reads the REPOSITORY,
// so it is blind by construction to the two things only the database knows: a grant made by
// hand against the live database, and a definer function that appears in no migration at
// all. A check verifying another system's work must not read the record our own code wrote
// (L58).
//
// Production holds one of the second kind. Measured 2026-09-16 and again 2026-09-17:
// Supabase's own `rls_auto_enable` reads executable for both anon and authenticated. It is
// not a live hole, because it returns `event_trigger` and PostgREST can only call a function
// whose result it can serialize, but it is proof that the repository and the database can
// disagree with nothing noticing.
//
// This file drives the PURE verdict offline. The live read is the monitor lane's, because
// only a connection can answer it.
//
// The shape that matters, and every one of these is asserted below:
//
//   unmeasured - the read failed, or came back empty. Slate DEFINES definer functions, so
//                zero rows is the shape of a broken read and never a healthy database (L98).
//                It pages nobody and it clears nothing.
//   healthy    - measured, and every executable function is one named and reasoned about.
//   exposed    - measured, and something the web roles can execute is not.
//
// The exemption is BY NAME AND BY ITS REASON, never a blanket filter (L129, L233). The
// reason `rls_auto_enable` is safe is its return type, so the return type is what the
// exemption is matched on: a platform function that started returning something PostgREST
// can serialize stops being exempt the moment it does, rather than staying excused by a
// name somebody wrote once.
import { assert, eq, finish } from "./lib/harness.ts";
import {
  PLATFORM_DEFINER_EXEMPTIONS,
  DEFINER_GRANTS_KEY,
  definerGrantsHealth,
  runDefinerGrantsCheck,
  formatDefinerGrantsExposedAlert,
  formatDefinerGrantsClearedAlert,
  type DefinerFunctionRow,
} from "@/lib/monitor/definer-grants";

function row(over: Partial<DefinerFunctionRow> = {}): DefinerFunctionRow {
  return {
    name: "erase_booking_pii",
    args: "target_email text",
    returns: "jsonb",
    anonExecute: false,
    authenticatedExecute: false,
    ...over,
  };
}

/** Production as measured on 2026-09-17: the platform function plus Slate's own, all revoked. */
const PLATFORM_ROW = row({
  name: "rls_auto_enable",
  args: "",
  returns: "event_trigger",
  anonExecute: true,
  authenticatedExecute: true,
});

// --- the exemption list is reasoned, not just populated -------------------------------
{
  assert(PLATFORM_DEFINER_EXEMPTIONS.length > 0, "there is at least one exemption to judge");
  for (const e of PLATFORM_DEFINER_EXEMPTIONS) {
    assert(e.reason.trim().split(/\s+/).length >= 8, `${e.name} carries a written reason, not a label`);
    assert(e.returns.trim().length > 0, `${e.name} names the return type its reason rests on`);
  }
}

// --- unmeasured: a read that learned nothing is never health --------------------------
{
  const unread = definerGrantsHealth({ rows: null });
  eq(unread.status, "unmeasured", "a failed read is unmeasured");

  const empty = definerGrantsHealth({ rows: [] });
  eq(empty.status, "unmeasured", "zero rows is unmeasured, because Slate defines definer functions");
  assert(
    empty.status === "unmeasured" && /no .*definer|zero|empty/i.test(empty.why),
    "and it says the read came back empty rather than blaming the database",
  );
}

// --- healthy: production as it stands today -------------------------------------------
{
  const health = definerGrantsHealth({
    rows: [PLATFORM_ROW, row(), row({ name: "move_busy_block", returns: "void" })],
  });
  eq(health.status, "healthy", "the measured production shape is healthy");
  eq(health.status === "healthy" ? health.scanned : -1, 3, "and it reports how many it read");
  eq(
    health.status === "healthy" ? health.exempted.join(",") : "",
    "rls_auto_enable",
    "naming the one it excused, so an excuse is never silent",
  );
}

// --- exposed: the fault this exists to catch ------------------------------------------
{
  const health = definerGrantsHealth({
    rows: [PLATFORM_ROW, row({ name: "erase_booking_pii", anonExecute: true })],
  });
  eq(health.status, "exposed", "a Slate definer function the web roles can execute is exposed");
  eq(
    health.status === "exposed" ? health.exposed.map((f) => f.name).join(",") : "",
    "erase_booking_pii",
    "and only that one is named",
  );
  assert(
    health.status === "exposed" && health.exposed[0].roles.join(",") === "anon",
    "naming WHICH role holds it, since the remedy differs",
  );
}

// --- the exemption is matched on its reason, not only its name ------------------------
{
  const health = definerGrantsHealth({
    rows: [row({ name: "rls_auto_enable", args: "", returns: "jsonb", anonExecute: true, authenticatedExecute: true })],
  });
  eq(
    health.status,
    "exposed",
    "a platform function that stopped returning event_trigger is no longer excused by its name",
  );
}

// --- an exemption covering nothing is reported, and does not page ----------------------
{
  const health = definerGrantsHealth({ rows: [row()] });
  eq(health.status, "healthy", "an unused exemption is not a fault: it suppresses nothing");
  eq(
    health.status === "healthy" ? health.unusedExemptions.join(",") : "",
    "rls_auto_enable",
    "but it is REPORTED, so a suppression covering nothing is visible rather than forgotten",
  );
}

// --- the copy a person reads mid incident ----------------------------------------------
{
  const exposed = definerGrantsHealth({
    rows: [row({ name: "erase_booking_pii", anonExecute: true, authenticatedExecute: true })],
  });
  const text = exposed.status === "exposed" ? formatDefinerGrantsExposedAlert(exposed) : "";
  assert(text.includes("erase_booking_pii"), "the alert names the function");
  assert(/anon/.test(text) && /authenticated/.test(text), "and both roles that can execute it");
  assert(!/^Slate\b/.test(text), "and does not open with the word Slate, which repeats the Slack header");
  assert(
    !text.split("").some((c) => c.charCodeAt(0) === 0x2014 || c.charCodeAt(0) === 0x2013),
    "and carries no dash punctuation",
  );

  const cleared = formatDefinerGrantsClearedAlert({ status: "healthy", scanned: 13, exempted: ["rls_auto_enable"], unusedExemptions: [] });
  assert(cleared.length > 0 && !/^Slate\b/.test(cleared), "the all clear reads as its own sentence");
  assert(/13/.test(cleared), "and says how many it measured, so nobody reads it as a read that found nothing");
}

// --- the silent paths: a tick that measured nothing must CLEAR nothing -----------------
//
// This is the failure path the whole detector family turns on (#1134, #1152). An all clear
// hangs off a MEASURED healthy result, never off "we did not alert this tick", so a read
// that threw and a read that came back empty both have to leave a live page standing.
{
  const notified: string[] = [];
  const resolved: string[] = [];
  const deps = {
    notify: async (key: string) => {
      notified.push(key);
    },
    resolve: async (key: string) => {
      resolved.push(key);
    },
    cooldownMs: 1_000,
  };

  const threw = await runDefinerGrantsCheck({
    ...deps,
    read: async () => {
      throw new Error("relation does not exist");
    },
  });
  eq(threw.status, "unmeasured", "a read that threw is unmeasured");
  eq(resolved.length, 0, "a read that threw clears nothing");
  eq(notified.length, 0, "and pages nobody, because it measured nothing either way");

  const empty = await runDefinerGrantsCheck({ ...deps, read: async () => [] });
  eq(empty.status, "unmeasured", "a read that came back empty is unmeasured");
  eq(resolved.length, 0, "a read that came back empty clears nothing");

  const nulled = await runDefinerGrantsCheck({ ...deps, read: async () => null });
  eq(nulled.status, "unmeasured", "a read that returned null is unmeasured");
  eq(resolved.length, 0, "a read that returned null clears nothing");
}

// --- and the control: a measured healthy tick DOES clear ------------------------------
//
// Without this the three above are satisfied by a check that can never clear at all (L159).
{
  const resolved: string[] = [];
  const notified: string[] = [];
  const healthy = await runDefinerGrantsCheck({
    read: async () => [PLATFORM_ROW, row()],
    notify: async (key: string) => {
      notified.push(key);
    },
    resolve: async (key: string) => {
      resolved.push(key);
    },
    cooldownMs: 1_000,
  });
  eq(healthy.status, "healthy", "a measured clean read is healthy");
  eq(resolved.join(","), DEFINER_GRANTS_KEY, "and it clears the condition");
  eq(notified.length, 0, "without paging anybody");
}

// --- and an exposed tick pages, and does not clear -------------------------------------
{
  const resolved: string[] = [];
  const notified: string[] = [];
  const exposed = await runDefinerGrantsCheck({
    read: async () => [PLATFORM_ROW, row({ anonExecute: true })],
    notify: async (key: string) => {
      notified.push(key);
    },
    resolve: async (key: string) => {
      resolved.push(key);
    },
    cooldownMs: 1_000,
  });
  eq(exposed.status, "exposed", "a measured exposure is exposed");
  eq(notified.join(","), DEFINER_GRANTS_KEY, "and it pages");
  eq(resolved.length, 0, "and clears nothing while it lasts");
}

finish();
