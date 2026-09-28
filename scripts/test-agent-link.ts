// The agent booking link (#2073): the token, the address, which bucket it books
// into, and who it may book.
//
// An agent sends a link for the later calls with a lead who is already theirs, so
// the link names ONE agent and never routes. These are the pure decisions under it;
// the reads that feed them live in src/lib/agent-link/store.ts.
// Run: node --experimental-strip-types scripts/test-agent-link.ts
import {
  AGENT_LINK_TOKEN_PATTERN,
  agentLinkPoolHref,
  agentLinkUrl,
  chooseAgentLinkBucket,
  chooseAgentLinkPoolCode,
  isWellFormedAgentLinkToken,
  judgeAgentLink,
  newAgentLinkToken,
} from "../src/lib/agent-link/link.ts";
import { assert, eq, finish } from "./lib/harness.ts";

// --- the token -------------------------------------------------------------
{
  const a = newAgentLinkToken();
  const b = newAgentLinkToken();
  assert(AGENT_LINK_TOKEN_PATTERN.test(a), "a minted token is 64 lowercase hex characters");
  assert(a !== b, "two mints differ");
  // 32 random bytes: the pattern fixes the length, so every byte position has to
  // be able to vary. A generator that zeroed half its buffer would still match
  // the pattern, so the distinct characters across many mints are counted.
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) for (const ch of newAgentLinkToken()) seen.add(ch);
  eq(seen.size, 16, "mints use every hex digit");

  // The database mints the first token with sha256(...) as hex, so the app's
  // shape and the CHECK in 0144 are one format.
  const fixed = newAgentLinkToken(() => new Uint8Array(32).fill(0xab));
  eq(fixed, "ab".repeat(32), "the token is the random bytes written as hex");
  let threw = false;
  try {
    newAgentLinkToken(() => new Uint8Array(16));
  } catch {
    threw = true;
  }
  assert(threw, "a source handing back fewer than 32 bytes is refused, never padded");
}

// --- well formed ----------------------------------------------------------
{
  const good = "0123456789abcdef".repeat(4);
  assert(isWellFormedAgentLinkToken(good), "64 lowercase hex is well formed");
  for (const [bad, why] of [
    ["", "empty"],
    [good.slice(1), "63 characters"],
    [good + "a", "65 characters"],
    [good.toUpperCase(), "upper case"],
    [` ${good}`, "a leading space"],
    [good.replace("a", "g"), "a character outside hex"],
    ["someone@trypennie.com", "an email address"],
  ] as const) {
    assert(!isWellFormedAgentLinkToken(bad), `refused: ${why}`);
  }
}

// --- the address -----------------------------------------------------------
{
  const t = "ab".repeat(32);
  eq(agentLinkUrl("https://slate.trypennie.app", t), `https://slate.trypennie.app/book/advisor/${t}`, "the address is /book/advisor/{token}");
  eq(agentLinkUrl("https://slate.trypennie.app/", t), `https://slate.trypennie.app/book/advisor/${t}`, "a trailing slash on the base is not doubled");
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
  eq(judgeAgentLink(null, [bucket]), { ok: false, why: "unknown" }, "no row for the token is refused");
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
