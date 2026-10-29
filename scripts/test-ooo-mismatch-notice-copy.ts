// #3372: the messages an agent and their manager read when an approved time off and
// the agent's Google Calendar stop matching, and the ones that say it is over.
//
// Pure builders with no clock, so every sentence is pinned here. The alerts channel
// page is also rendered by `pnpm preview:alerts`; the DMs are not, since they go to a
// person rather than to a catalogued alert key, so this suite is where they are read.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ooo-mismatch-notice-copy.ts
import {
  agentMismatchDm,
  managerMismatchDm,
  agentMismatchClearedDm,
  managerMismatchClearedDm,
  type ClearedTimeOff,
} from "../src/lib/ooo/mismatch-notice-copy.ts";
import { oooEventMismatchAlert, type OooEventMismatch } from "../src/lib/ooo/alert-copy.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const APP = "https://slate.example.com";
// The 2026-10-06 shape: all of Wednesday in MT, the event moved to 11:30 AM.
const shortened: OooEventMismatch = {
  requestId: "req_9f2",
  startsAt: "2026-10-07T06:00:00.000Z",
  endsAt: "2026-10-08T05:59:00.000Z",
  displayTzId: "America/Denver",
  displayTzLabel: "MT",
  coverage: {
    kind: "uncovered",
    spans: [{ startMs: Date.parse("2026-10-07T06:00:00.000Z"), endMs: Date.parse("2026-10-07T17:30:00.000Z") }],
  },
};
const gone: OooEventMismatch = {
  ...shortened,
  requestId: "req_a41",
  startsAt: "2026-10-09T06:00:00.000Z",
  endsAt: "2026-10-10T05:59:00.000Z",
  coverage: { kind: "not-blocking", unmeasured: null },
};
// A second agent, in Los Angeles, so the zone is visibly the agent's own.
const pacific: OooEventMismatch = { ...shortened, displayTzId: "America/Los_Angeles", displayTzLabel: "PT" };

// Built from code points so this file holds no literal dash for the style gate to find.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const clean = (text: string, what: string) => {
  assert(!DASHES.test(text), `${what} carries no en or em dash`);
  assert(!/\p{Extended_Pictographic}/u.test(text), `${what} carries no emoji`);
  assert(!/:\w+:/.test(text), `${what} carries no emoji shortcode`);
  assert(!/^\s*Slate\b/i.test(text), `${what} does not open with the word Slate`);
  assert(!/\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/.test(text), `${what} leaks no missing value`);
};

// The agent.
{
  const text = agentMismatchDm([shortened], APP);
  clean(text, "the agent's message");
  assert(text.includes("Wed, Oct 7 2026"), "names the approved day");
  assert(text.includes("11:30am MT"), "names where the open hours end, in the agent's own zone");
  assert(text.includes("12:00am"), "names where the open hours begin");
  assert(/put .*event back/i.test(text), "offers the first fix: put the calendar event back");
  assert(text.includes("My time off"), "offers the second fix: change the request in My time off");
  assert(/manager/i.test(text), "says a change goes back to their manager");
  assert(text.includes(`${APP}/me/time-off`), "links to My time off");
  assert(/still blocked/i.test(text), "says the approved hours stay blocked, so nobody rushes");
  assert(!text.includes("req_9f2"), "does not show the agent an internal request id");
}
{
  const text = agentMismatchDm([pacific], APP);
  assert(text.includes("PT"), "an agent in Los Angeles reads Pacific time");
  assert(!text.includes(" MT"), "and never Mountain time they do not keep");
}
{
  const text = agentMismatchDm([gone], APP);
  clean(text, "the agent's message for a missing event");
  assert(/no busy time off event|no time off event/i.test(text), "a missing event is said as missing, not as shortened");
  assert(!/leaves .* open/.test(text), "and is not described as leaving some hours open");
}
{
  const text = agentMismatchDm([shortened, gone], APP);
  assert(text.includes("Wed, Oct 7 2026") && text.includes("Fri, Oct 9 2026"), "two requests are both named");
  assert(/2 approved time off requests/i.test(text), "and counted");
}

// The manager.
const told = { atMs: Date.parse("2026-10-06T15:05:00.000Z") };
{
  const text = managerMismatchDm({
    agentName: "Heather McLellen",
    items: [{ finding: shortened, bookedInGap: false }],
    agentTold: told,
    appBaseUrl: APP,
  });
  clean(text, "the manager's message");
  assert(text.startsWith("Heather McLellen"), "names the agent first");
  assert(text.includes("Wed, Oct 7 2026"), "names the request's window");
  assert(text.includes("11:30am MT"), "names the uncovered hours");
  assert(text.includes("Tue, Oct 6 2026 at 9:05am MT"), "says when the agent was told, in the request's zone");
  assert(text.includes(`${APP}/admin/ooo?request=req_9f2`), "links to the request");
  assert(/My time off/.test(text) && /back/i.test(text), "names both fixes");
  assert(!/booked inside/i.test(text), "says nothing about a call when none is booked in the gap");
}
{
  const text = managerMismatchDm({
    agentName: "Heather McLellen",
    items: [{ finding: shortened, bookedInGap: true }],
    agentTold: told,
    appBaseUrl: APP,
  });
  assert(/call is already booked/i.test(text), "says when a call is already booked inside the gap");
}
{
  const text = managerMismatchDm({
    agentName: "Heather McLellen",
    items: [{ finding: shortened, bookedInGap: false }],
    agentTold: "unreachable",
    appBaseUrl: APP,
  });
  clean(text, "the manager's message when the agent could not be reached");
  assert(/could not be delivered/i.test(text), "says the agent's message did not arrive, so the manager hears first");
  assert(!text.includes(" at 9:05am"), "and claims no time the agent was told");
}

// The all-clears.
const when = { startsAt: shortened.startsAt, endsAt: shortened.endsAt, displayTzId: "America/Denver", displayTzLabel: "MT" };
const cases: { why: ClearedTimeOff["why"]; agent: RegExp; manager: RegExp }[] = [
  { why: "agreed", agent: /matches .* again/i, manager: /match again/i },
  { why: "changed", agent: /changed/i, manager: /changed/i },
  { why: "cancelled", agent: /cancelled/i, manager: /cancelled/i },
  { why: "declined", agent: /declined/i, manager: /declined/i },
  { why: "passed", agent: /passed/i, manager: /passed/i },
];
const seenAgent = new Set<string>();
for (const c of cases) {
  const item: ClearedTimeOff = { why: c.why, when };
  const a = agentMismatchClearedDm(item);
  const m = managerMismatchClearedDm("Heather McLellen", item);
  clean(a, `the agent's all-clear (${c.why})`);
  clean(m, `the manager's all-clear (${c.why})`);
  assert(c.agent.test(a), `the agent's all-clear says why it is over (${c.why})`);
  assert(c.manager.test(m), `the manager's all-clear says why it is over (${c.why})`);
  assert(a.includes("Wed, Oct 7 2026"), `the agent's all-clear names the window (${c.why})`);
  assert(m.includes("Heather McLellen"), `the manager's all-clear names the agent (${c.why})`);
  assert(/nothing (more|left)/i.test(a), `the agent's all-clear says there is nothing to do (${c.why})`);
  seenAgent.add(a);
}
eq(seenAgent.size, cases.length, "every reason reads differently to the agent (L11)");
{
  const a = agentMismatchClearedDm({ why: "gone", when: null });
  const m = managerMismatchClearedDm("Heather McLellen", { why: "gone", when: null });
  clean(a, "the agent's all-clear for a request that could not be read back");
  clean(m, "the manager's all-clear for a request that could not be read back");
  assert(/no longer approved/i.test(a), "claims only that it is no longer approved");
}

// The alerts channel: one reason per combination of who was reached (L11).
{
  const page = (agent: "told" | "unreachable", manager: "told" | "none" | "unreachable") =>
    oooEventMismatchAlert("Heather McLellen", [shortened], APP, { agent, manager });
  const neither = page("told", "told");
  const none = page("told", "none");
  const lost = page("told", "unreachable");
  const agentLost = page("unreachable", "told");
  const agentLostNone = page("unreachable", "none");
  const bothLost = page("unreachable", "unreachable");
  const all = [neither, none, lost, agentLost, agentLostNone, bothLost];
  for (const t of all) {
    clean(t, "the alerts channel page");
    assert(t.includes("req_9f2"), "the alerts channel page names the request");
  }
  assert(/both told/i.test(neither) && /manager/i.test(neither), "the page says the agent and the manager were told and neither acted");
  assert(/no manager of record/i.test(none), "the page says there was no manager to tell");
  assert(/could not be delivered/i.test(lost), "the page says the manager's message did not arrive");
  for (const t of [agentLost, agentLostNone, bothLost]) {
    assert(/message to Heather McLellen could not be delivered|Heather McLellen nor/i.test(t) && !/both told/i.test(t),
      `an agent who was never reached is never said to have been told (${t.slice(0, 160)})`);
  }
  eq(new Set(all).size, 6, "six histories, six pages");
}
{
  // Two requests that reached the channel for different reasons: neither reason is
  // stated for both, each request's block carries its own.
  const other = { ...shortened, requestId: "req_a41" };
  const t = oooEventMismatchAlert("Heather McLellen", [shortened, other], APP, [
    { agent: "told", manager: "told" },
    { agent: "told", manager: "none" },
  ]);
  clean(t, "a page with mixed reasons");
  // Each request is its own block (Approved, its reason, then the link alone on the
  // last line), separated by a blank line.
  const blocks = t.split("\n\n");
  const l1 = blocks.find((b) => b.includes("req_9f2")) ?? "";
  const l2 = blocks.find((b) => b.includes("req_a41")) ?? "";
  assert(/both told/i.test(l1) && !/no manager of record/i.test(l1), `the first request's block carries its own reason (${l1})`);
  assert(/no manager of record/i.test(l2) && !/both told/i.test(l2), `the second request's block carries its own reason (${l2})`);
  assert(l1.split("\n").at(-1) === `${APP}/admin/ooo?request=req_9f2`, "and its link sits alone on the block's last line");
  assert(!/both told/i.test(blocks[0] ?? ""), "and the opening sentence states neither reason for every request");
  // Dan (2026-10-29): a shortened event's open hours come first, then the reason, then the link.
  eq(
    l1,
    "Approved: Wed, Oct 7 2026 from 12:00am - 11:59pm MT\n" +
      "Calendar leaves Wed, Oct 7 2026 from 12:00am - 11:30am MT open\n" +
      "Heather McLellen and their manager were both told on Slack and neither has fixed it.\n" +
      `${APP}/admin/ooo?request=req_9f2`,
    "a shortened request's block reads open hours, then its reason, then its link",
  );
}
{
  // Dan (2026-10-29): only a SHORTENED event keeps a line, naming the open hours, with
  // no full stop, between the Approved line and the link.
  const t = oooEventMismatchAlert("Heather McLellen", [shortened], "https://slate.trypennie.app", {
    agent: "told",
    manager: "told",
  });
  assert(
    t.endsWith(
      "\n\nApproved: Wed, Oct 7 2026 from 12:00am - 11:59pm MT\n" +
        "Calendar leaves Wed, Oct 7 2026 from 12:00am - 11:30am MT open\n" +
        "https://slate.trypennie.app/admin/ooo?request=req_9f2",
    ),
    `a shortened event's block names the open hours exactly as Dan worded it (${t.split("\n\n").at(-1)})`,
  );
  const two = oooEventMismatchAlert(
    "Heather McLellen",
    [{ ...shortened, coverage: { kind: "uncovered", spans: [
      { startMs: Date.parse("2026-10-07T06:00:00.000Z"), endMs: Date.parse("2026-10-07T17:30:00.000Z") },
      { startMs: Date.parse("2026-10-07T22:00:00.000Z"), endMs: Date.parse("2026-10-08T05:59:00.000Z") },
    ] } }],
    APP,
    { agent: "told", manager: "told" },
  );
  assert(
    two.includes("\nCalendar leaves Wed, Oct 7 2026 from 12:00am - 11:30am MT and Wed, Oct 7 2026 from 4:00pm - 11:59pm MT open\n"),
    `two open spans are both named on the one line (${two.split("\n\n").at(-1)})`,
  );
  const goneText = oooEventMismatchAlert("Heather McLellen", [gone], APP, { agent: "told", manager: "told" });
  assert(!/Calendar leaves/.test(goneText), "a missing event carries no open hours line");
}
{
  // Dan's own wording (2026-10-29), pinned word for word against the page that posted
  // for Amanda Ferguson that day: an all day request whose event was gone, and both
  // the agent and her manager told. The calendar reason sentence is deliberately
  // gone, there is a blank line before "Action required:" and before "Approved:",
  // the Approved line carries no full stop, and the link sits alone on the last line.
  const amanda: OooEventMismatch = {
    requestId: "788d0b74-973a-4f64-a32f-169f1849af4b",
    startsAt: "2026-10-29T06:00:00.000Z",
    endsAt: "2026-10-30T05:59:00.000Z",
    displayTzId: "America/Denver",
    displayTzLabel: "MT",
    coverage: { kind: "not-blocking", unmeasured: null },
  };
  eq(
    oooEventMismatchAlert("Amanda Ferguson", [amanda], "https://slate.trypennie.app", { agent: "told", manager: "told" }),
    "Amanda Ferguson's Google Calendar no longer matches an approved time off. Amanda Ferguson and their manager " +
      "were both told on Slack and neither has fixed it. Slate is still blocking the originally approved window, " +
      "so no lead can be booked into it.\n" +
      "\n" +
      "Action required: Make the two agree: if those hours are being worked, change the request in My time off " +
      "(it goes back to the manager to approve); if they are not, put the calendar event back to the approved times.\n" +
      "\n" +
      "Approved: Thu, Oct 29 2026 from 12:00am - 11:59pm MT\n" +
      "https://slate.trypennie.app/admin/ooo?request=788d0b74-973a-4f64-a32f-169f1849af4b",
    "the alerts channel page reads exactly as Dan worded it",
  );
}

finish();
