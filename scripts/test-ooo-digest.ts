// Tests for the daily pending-OOO digest core (send-time gate + message build).
// Run: node --experimental-strip-types scripts/test-ooo-digest.ts
import {
  buildOooDigests,
  isDigestTime,
  DIGEST_MAX_INTERACTIVE,
  type DigestPerson,
} from "../src/lib/ooo/digest.ts";
import {
  OOO_APPROVE_ACTION,
  OOO_REJECT_ACTION,
} from "../src/lib/notify/ooo-slack-blocks.ts";
import { assert, finish } from "./lib/harness.ts";

// --- send-time gate (9am ET weekdays) across DST ---
// EDT (summer): 9am ET = 13:00 UTC. 2026-07-01 is a Wednesday.
assert(isDigestTime(Date.parse("2026-07-01T13:00:00Z")), "13:00 UTC summer = 9am EDT");
assert(!isDigestTime(Date.parse("2026-07-01T14:00:00Z")), "14:00 UTC summer = 10am EDT (skip)");
// EST (winter): 9am ET = 14:00 UTC. 2026-01-07 is a Wednesday.
assert(!isDigestTime(Date.parse("2026-01-07T13:00:00Z")), "13:00 UTC winter = 8am EST (skip)");
assert(isDigestTime(Date.parse("2026-01-07T14:00:00Z")), "14:00 UTC winter = 9am EST");
// weekends never fire (2026-07-04 is a Saturday, 9am EDT = 13:00 UTC).
assert(!isDigestTime(Date.parse("2026-07-04T13:00:00Z")), "Saturday is skipped");
// off-hours never fire.
assert(!isDigestTime(Date.parse("2026-07-01T18:00:00Z")), "2pm ET is skipped");

// --- message building ---
const managers = new Map<string, DigestPerson>([
  ["m1", { id: "m1", email: "mona@x.com", name: "Mona", role: "manager" }],
  ["m2", { id: "m2", email: "noname@x.com", name: null, role: "manager" }],
  // #1475: named as somebody's manager of record but not allowed to approve.
  ["low", { id: "low", email: "andy@x.com", name: "Andy", role: "agent" }],
]);
const req = (id: string, manager_id: string | null) => ({
  id,
  manager_id,
  line: `*Agent ${id}* wants time off\nReason: test`,
});
const pending = [
  req("r1", "m1"),
  req("r2", "m1"),
  req("r3", "m1"),
  req("r4", "m2"),
  req("r5", null), // #1499: no manager of record
  req("r6", "ghost"), // manager of record not resolvable
  req("r7", "low"), // #1475: named manager cannot approve
];
const { managers: digests, unrouted } = buildOooDigests(
  pending,
  managers,
  "https://slate.test/admin/ooo",
);

assert(digests.length === 2, "one digest per resolvable manager with pending");
assert(digests[0].managerId === "m1" && digests[0].count === 3, "busiest manager first");

// The fallback text (notification preview + accessibility) is unchanged.
assert(
  digests[0].text.includes("Good morning, Mona.") &&
    digests[0].text.includes("*3* time off requests") &&
    digests[0].text.includes("https://slate.test/admin/ooo"),
  "fallback text has greeting, count, plural noun, and review link",
);
assert(
  digests[1].text.startsWith("Good morning. You have *1* time off request "),
  "no-name fallback greeting and singular noun",
);
assert(
  !digests.some((d) => d.text.includes("—") || d.text.includes("–")),
  "no em or en dashes in the copy",
);

// --- interactive blocks: one Approve/Decline row per pending request (#194) ---
type Block = { type?: string; block_id?: string; text?: { text?: string } };
const m1Blocks = digests[0].blocks as Block[];
const header = m1Blocks[0];
assert(
  header.type === "section" &&
    !!header.text?.text?.includes("Good morning, Mona.") &&
    !!header.text?.text?.includes("*3*"),
  "digest leads with a greeting + count header section",
);
const actionRows = m1Blocks.filter((b) => b.type === "actions");
assert(actionRows.length === 3, "one action (Approve/Decline) row per pending request");
const rowIds = actionRows.map((b) => b.block_id).sort();
assert(
  JSON.stringify(rowIds) === JSON.stringify(["ooo_actions:r1", "ooo_actions:r2", "ooo_actions:r3"]),
  "each action row carries its own request id so the buttons act on the right request",
);
const buttons = actionRows.flatMap(
  (b) => (b as { elements?: { action_id?: string; value?: string }[] }).elements ?? [],
);
assert(
  buttons.some((e) => e.action_id === OOO_APPROVE_ACTION && e.value === "r1") &&
    buttons.some((e) => e.action_id === OOO_REJECT_ACTION && e.value === "r1"),
  "each request has an Approve and a Decline button wired to its id",
);
assert(
  m1Blocks.some((b) => !!b.text?.text?.includes("*Agent r1* wants time off")),
  "each request's descriptive line is rendered",
);
assert(
  m1Blocks.some(
    (b) => b.type === "section" && !!b.text?.text?.includes("https://slate.test/admin/ooo"),
  ),
  "a review link section is included so the manager can still open the full page",
);

// --- overflow: a large backlog is capped but NEVER silently truncated (#194) ---
const bigMgr = new Map<string, DigestPerson>([
  ["big", { id: "big", email: "big@x.com", name: "Bianca", role: "manager" }],
]);
const bigPending = Array.from({ length: DIGEST_MAX_INTERACTIVE + 4 }, (_, i) =>
  req(`b${i}`, "big"),
);
const [bigDigest] = buildOooDigests(bigPending, bigMgr, "https://slate.test/admin/ooo").managers;
const bigBlocks = bigDigest.blocks as Block[];
assert(bigDigest.count === DIGEST_MAX_INTERACTIVE + 4, "count reflects the FULL backlog, not the shown subset");
assert(
  bigBlocks.filter((b) => b.type === "actions").length === DIGEST_MAX_INTERACTIVE,
  "button rows are capped at DIGEST_MAX_INTERACTIVE (Slack block ceiling)",
);
assert(
  bigBlocks.some((b) => !!b.text?.text?.includes("And 4 more")),
  "the remaining requests are disclosed, never silently dropped",
);

// --- empty pending -> no digests ---
{
  const empty = buildOooDigests([], managers, "x");
  assert(empty.managers.length === 0 && empty.unrouted === null, "no pending, no digests");
}

finish();

// --- #1499: every pending request reaches SOMEBODY's nudge ---
//
// The digest used to filter `manager_id is not null` and then skip any request
// whose manager did not resolve, so three shapes were silently dropped from the
// daily nudge and nobody was ever reminded about them: no manager of record
// (nine active people, every one of Pennie's debt managers among them), a
// manager of record who cannot approve (#1475), and a manager id that reads back
// as nobody. The split is exhaustive by construction, so a request can never
// fall between the two views (L45).
{
  const routedIds = digests.flatMap((d) =>
    ((d.blocks as Block[]).filter((b) => b.type === "actions") as { block_id?: string }[]).map(
      (b) => (b.block_id ?? "").replace("ooo_actions:", ""),
    ),
  );
  const unroutedIds = ((unrouted?.blocks ?? []) as Block[])
    .filter((b) => b.type === "actions")
    .map((b) => ((b as { block_id?: string }).block_id ?? "").replace("ooo_actions:", ""));
  const covered = new Set([...routedIds, ...unroutedIds]);
  assert(
    pending.every((r) => covered.has(r.id)),
    `every pending request is nudged somewhere (missing: ${pending
      .filter((r) => !covered.has(r.id))
      .map((r) => r.id)
      .join(", ")})`,
  );
  // #2235: the overlap count is read with the filter's INPUT asserted in the same
  // breath. Two empty lists overlap in nothing, so a routing step that produced
  // no blocks at all would satisfy the zero below while proving nothing: nothing
  // matched and everything passed are the same number (L98).
  assert(
    routedIds.length > 0 && unroutedIds.length > 0,
    `both nudge lists carry something to compare (routed ${routedIds.length}, unrouted ${unroutedIds.length})`,
  );
  assert(
    routedIds.filter((id) => unroutedIds.includes(id)).length === 0,
    "and no request is nudged twice",
  );
}

assert(unrouted !== null && unrouted.count === 3, "r5, r6 and r7 have nobody to nudge");
assert(
  !!unrouted && unrouted.text.includes("*3*") && unrouted.text.includes("https://slate.test/admin/ooo"),
  "the unrouted post carries the count and the review link",
);
assert(
  !!unrouted && /team lead or admin/i.test(unrouted.text),
  "and names who can act on them",
);
// L11: three causes, three sentences. A reader has to know whether this is a
// roster repair (a wrong or missing manager) or simply nobody being named.
{
  const text = JSON.stringify(unrouted?.blocks ?? []);
  assert(text.includes("No manager of record"), "the no-manager cause is named");
  assert(
    text.includes("Andy") && text.includes("cannot approve"),
    "the manager-cannot-approve cause names the manager and the reason",
  );
  assert(
    text.includes("could not be found"),
    "the unresolvable-manager cause is named as its own third thing",
  );
  assert(
    !/ask an admin to set/i.test(text),
    "and none of them names the step nobody can perform (L111)",
  );
}
// No unrouted work means no post at all, rather than an empty one.
assert(
  buildOooDigests([req("x", "m1")], managers, "https://slate.test/admin/ooo").unrouted === null,
  "nothing unrouted means no fallback post",
);
// Written as escapes, not literals, so this file holds no dash for the pre-push
// style hook to catch: it cannot tell the line banning the character from a line
// using it.
const DASHES = /[\u2014\u2013]/;
assert(!DASHES.test(unrouted?.text ?? ""), "no em or en dashes in the unrouted copy");
