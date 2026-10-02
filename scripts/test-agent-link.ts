// The agent booking link (#2073): what a value in the address can be, the address,
// which bucket it books into, and who it may book.
//
// An agent sends a link for the later calls with a lead who is already theirs, so
// the link names ONE agent and never routes. Since #3026 the address carries a
// readable NAME (the email username, minted by the database in migration 0155),
// and every link sent before that still carries a 64 hex token. These are the pure
// decisions under it; the reads that feed them live in src/lib/agent-link/store.ts.
// The SQL that derives and reserves the names is proved in a real Postgres by
// `pnpm verify:agent-link-names`; this file holds the app to the same shape.
// Run: node --experimental-strip-types scripts/test-agent-link.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_LINK_NAME_MAX_CHARS,
  AGENT_LINK_NAME_PATTERN,
  AGENT_LINK_TOKEN_PATTERN,
  agentLinkPoolHref,
  agentLinkUrl,
  chooseAgentLinkBucket,
  chooseAgentLinkPoolCode,
  judgeAgentLink,
  readAgentLinkKey,
} from "../src/lib/agent-link/link.ts";
import * as linkModule from "../src/lib/agent-link/link.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(import.meta.dirname, "..");

// --- what a value in the address is (#3026) ----------------------------------
{
  const oldLink = "0123456789abcdef".repeat(4);
  eq(readAgentLinkKey(oldLink), { kind: "token", token: oldLink }, "64 lowercase hex is an old #2073 token");
  eq(readAgentLinkKey("ab".repeat(32)), { kind: "token", token: "ab".repeat(32) }, "any 64 hex value is a token");
  for (const name of ["rdaboub", "rdaboub2", "j.smith", "first_last", "a-b", "x", "1a"]) {
    eq(readAgentLinkKey(name), { kind: "name", name }, `"${name}" is a name`);
  }
  // A token shaped value is ALWAYS read as a token, which is why the database
  // refuses a token shaped name: the two readings can never both apply.
  for (const v of ["rdaboub", "ab".repeat(32), "a.b"]) {
    const asName = AGENT_LINK_NAME_PATTERN.test(v) && !AGENT_LINK_TOKEN_PATTERN.test(v);
    const asToken = AGENT_LINK_TOKEN_PATTERN.test(v);
    assert(!(asName && asToken), `"${v.slice(0, 12)}" cannot be both a name and a token`);
  }
  for (const [bad, why] of [
    ["", "empty"],
    [oldLink.slice(1).toUpperCase(), "upper case"],
    ["Rdaboub", "a capital"],
    [` ${oldLink}`, "a leading space"],
    ["someone@trypennie.com", "an email address"],
    [".", "a dot alone"],
    ["..", "a parent path"],
    [".rdaboub", "leading punctuation"],
    ["rdaboub.", "trailing punctuation"],
    ["a/b", "a slash"],
    ["a%2Fb", "an encoded character"],
    ["a".repeat(AGENT_LINK_NAME_MAX_CHARS + 1), "a name past the length cap"],
  ] as const) {
    eq(readAgentLinkKey(bad), null, `refused before any read: ${why}`);
  }
  // Positive control for the cap: exactly the cap is accepted, so the refusal
  // above is the length and not the characters.
  eq(
    readAgentLinkKey("a".repeat(AGENT_LINK_NAME_MAX_CHARS))?.kind,
    "name",
    "a name exactly at the cap is accepted",
  );
}

// --- the app and the database agree on the shape (#3026) ------------------------
{
  // The database CHECK is what mints and holds every name, and this module is what
  // decides whether a value from the URL is worth a read. If they drifted, a real
  // name would be refused before its read, or a token shaped name could exist.
  const migration = readFileSync(join(ROOT, "supabase", "migrations", "0155_agent_link_names.sql"), "utf8");
  const nameRegex = AGENT_LINK_NAME_PATTERN.source.replace("(?:", "(");
  assert(migration.includes(`check (name ~ '${nameRegex}')`), `the migration's shape CHECK is the app's pattern (${nameRegex})`);
  assert(
    migration.includes(`check (name !~ '${AGENT_LINK_TOKEN_PATTERN.source}')`),
    "the migration refuses a token shaped name with the app's token pattern",
  );
  assert(
    migration.includes(`check (char_length(name) between 1 and ${AGENT_LINK_NAME_MAX_CHARS})`),
    "the migration's length cap is the app's",
  );
  // A name outlives its user: deleting the user must never cascade the name away.
  assert(
    /user_id uuid unique references users\(id\) on delete set null/.test(migration),
    "a deleted user leaves their name reserved (ON DELETE SET NULL)",
  );
  assert(!/on delete cascade/i.test(migration), "nothing in the migration lets a delete free a name");
  assert(/after insert on users/.test(migration) && !/after update[^;]*on users/.test(migration), "the name is set on insert and never follows an email change");
}

// --- replacing a link is gone (#3026) ---------------------------------------------
{
  // Nothing has ever been replaced, and a name cannot be swapped without renaming
  // somebody, so the control, its action and the app side mint were removed rather
  // than left as dead code (Dan, 2026-10-02).
  assert(!("newAgentLinkToken" in linkModule), "the app no longer mints tokens");
  const store = readFileSync(join(ROOT, "src", "lib", "agent-link", "store.ts"), "utf8");
  const actions = readFileSync(join(ROOT, "src", "app", "admin", "actions.ts"), "utf8");
  assert(!store.includes("replaceAgentLinkToken"), "the store has no replace write");
  assert(!actions.includes("replaceAgentBookingLink"), "the admin actions have no replace action");
  // Positive control: the scan reads the real files, which do name the link.
  assert(store.includes("resolveAgentLink"), "positive control: the store file was read");
}

// --- the address -----------------------------------------------------------
{
  eq(agentLinkUrl("https://slate.trypennie.app", "rdaboub"), "https://slate.trypennie.app/book/advisor/rdaboub", "the address is /book/advisor/{name}");
  eq(agentLinkUrl("https://slate.trypennie.app/", "rdaboub"), "https://slate.trypennie.app/book/advisor/rdaboub", "a trailing slash on the base is not doubled");
}

// --- which bucket a named booking lands in ----------------------------------
{
  eq(chooseAgentLinkBucket([]), null, "an agent in no bucket has nowhere to book");
  eq(
    chooseAgentLinkBucket([
      { code: "521", is_test: false },
      { code: "411", is_test: false },
      { code: "SMOKE", is_test: true },
    ])?.code,
    "411",
    "the lowest real code, whatever order the rows arrive in",
  );
  eq(
    chooseAgentLinkBucket([
      { code: "411", is_test: false },
      { code: "521", is_test: false },
    ])?.code,
    chooseAgentLinkBucket([
      { code: "521", is_test: false },
      { code: "411", is_test: false },
    ])?.code,
    "the choice is stable across row order",
  );
  eq(
    chooseAgentLinkBucket([{ code: "SMOKE", is_test: true }])?.code,
    "SMOKE",
    "a test agent in only a test bucket books there, so the link can be tested without a real lead",
  );
}

// --- who the link may book ---------------------------------------------------
{
  const agent = { id: "u1", name: "Jane Doe", email: "jane@x.com", bookable: true, deactivated_at: null };
  const bucket = { code: "411", is_test: false };
  eq(judgeAgentLink(null, [bucket]), { ok: false, why: "unknown" }, "no user for the link is refused");
  eq(
    judgeAgentLink({ ...agent, deactivated_at: "2026-09-01T00:00:00Z" }, [bucket]),
    { ok: false, why: "departed" },
    "a departed agent is refused",
  );
  eq(judgeAgentLink({ ...agent, bookable: false }, [bucket]), { ok: false, why: "not_bookable" }, "an agent who is not bookable is refused");
  eq(judgeAgentLink(agent, []), { ok: false, why: "no_bucket" }, "a bookable agent in no bucket is refused");
  const ok = judgeAgentLink(agent, [bucket]);
  assert(ok.ok && ok.agent.id === "u1" && ok.bucketCode === "411", "a bookable agent in a bucket may be booked, in that bucket");
  // Departure is judged before bookability: a departed row keeps whatever bookable
  // said when they left, and the log line should name the stronger fact.
  eq(
    judgeAgentLink({ ...agent, bookable: false, deactivated_at: "2026-09-01T00:00:00Z" }, [bucket]),
    { ok: false, why: "departed" },
    "departed outranks not bookable",
  );
}

// --- the way on when the link books nobody (#2831) ----------------------------
{
  // The pool a refused link offers is the advisor's own lowest REAL bucket, the
  // one #2073 files their link bookings under. Never a test bucket: a lead offered
  // another advisor is offered a real pool or the catch all, nothing else.
  eq(chooseAgentLinkPoolCode([]), null, "an advisor in no bucket offers the catch all");
  eq(
    chooseAgentLinkPoolCode([
      { code: "511", is_test: false },
      { code: "SMOKE", is_test: true },
      { code: "411", is_test: false },
    ]),
    "411",
    "the lowest real code, whatever order the rows arrive in",
  );
  eq(
    chooseAgentLinkPoolCode([{ code: "SMOKE", is_test: true }]),
    null,
    "a test only advisor offers the catch all, never the test pool",
  );

  eq(agentLinkPoolHref("411", {}), "/book?xbc=411", "a known advisor leads to their own pool");
  // An unknown, replaced or poolless link leads to the catch all: the ordinary
  // booker with no code, which routes the way every blank code does (#1908).
  eq(agentLinkPoolHref(null, {}), "/book", "an unknown link leads to the catch all booker");

  // The lead's own details and the embed's settings travel with them, so the
  // routed booker is prefilled and still draws inside the host's frame.
  const sp = {
    name: "Dana Lee",
    email: "dana@example.com",
    external_id: "00Q000000000001",
    embed: "1",
    theme: "dark",
    parentOrigin: "https://www.trypennie.com",
  };
  const url = new URL(agentLinkPoolHref("411", sp), "https://slate.example");
  eq(url.pathname, "/book", "the routed booker's path");
  eq(url.searchParams.get("xbc"), "411", "the pool code");
  for (const [k, v] of Object.entries(sp)) eq(url.searchParams.get(k), v, `forwards ${k}`);

  // A code on the advisor link is not the lead's routing code and must never
  // override the pool: the pool is decided here, or left to the catch all.
  eq(
    new URL(agentLinkPoolHref("411", { xbc: "999" }), "https://s.x").searchParams.getAll("xbc"),
    ["411"],
    "the advisor's pool wins over any code on the link",
  );
  eq(
    new URL(agentLinkPoolHref(null, { xbc: "999" }), "https://s.x").searchParams.has("xbc"),
    false,
    "the catch all carries no code, even one the link arrived with",
  );
  // The advisor link's attribution does not follow the lead: a booking made from
  // the button is an ordinary routed one, not an advisor's direct link.
  eq(
    new URL(agentLinkPoolHref("411", { source: "agent-direct" }), "https://s.x").searchParams.has("source"),
    false,
    "the direct link attribution does not follow the lead into the pool",
  );
  eq(
    new URL(agentLinkPoolHref("411", { source: "offerhub" }), "https://s.x").searchParams.get("source"),
    "offerhub",
    "a source the link named for itself still travels",
  );
  eq(
    new URL(agentLinkPoolHref(null, { name: ["A", "B"] }), "https://s.x").searchParams.get("name"),
    "A",
    "a repeated key takes its first value, as every booker page does",
  );
  eq(
    new URL(agentLinkPoolHref(null, { name: "A&xbc=999" }), "https://s.x").searchParams.has("xbc"),
    false,
    "a value is encoded, so it cannot smuggle a code in",
  );
  eq(
    new URL(agentLinkPoolHref(null, { name: "A&xbc=999" }), "https://s.x").searchParams.get("name"),
    "A&xbc=999",
    "and it arrives intact",
  );
}

finish();
