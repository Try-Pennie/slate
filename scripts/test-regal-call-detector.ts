// Somebody placing calls in Regal while Slate will not route to them (#2090). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-regal-call-detector.ts
//
// This file pins:
//   1. the pure decision: routable, exempt by role, exempt by the ignore list, a
//      test user, somebody no longer in Slate, and EVERY combination of those, with
//      each reason distinct in the output rather than folded into one "skipped";
//   2. the role exemption derived from the Role union (a sixth role is a build
//      failure, pinned by the type test beside the module and asserted here against
//      the union's own text);
//   3. the detector FIRING on a planted violation and staying quiet on an ignored
//      one (L1: a guard is real only once it has been seen to fail);
//   4. the failure path: an unreadable read reports unmeasured, stamps no verdict,
//      pages nothing and clears nothing;
//   5. the two endings of a page, which must not share wording (L11): became
//      routable is a recovery, being added to the ignore list is a suppression.
//   6. #2724, the Redistribute exemption: a switched off agent Twilio tags
//      Redistribute is exempt as `redistribute` and gets no page, the SAME agent
//      without the tag is flagged (the positive control in the same fixture, L159),
//      Slate's own `redistribute` mark alone does not exempt, a deactivated agent is
//      not exempt, the tag coming off reopens the finding, a page already open
//      closes with suppression wording, and a failed read of the tag's source
//      (the roster) clears nothing and exempts nobody.
//   7. #2735: a tagged agent whose Twilio worker the last roster sync could not
//      find is NOT exempt, pages with its own wording, and the exempt twin in the
//      same fixture is the positive control.
import { readFileSync } from "node:fs";
import {
  judgeRegalCallers,
  settleRegalCallAlerts,
  runRegalCallCheck,
  regalCallAlertKey,
  formatRegalCallAlert,
  formatRegalCallEnding,
  REGAL_ROLE_EXEMPT,
  REGAL_CALL_WINDOW_MS,
  REGAL_CALL_ALERT_PREFIX,
  type RegalCaller,
  type RegalCandidate,
  type RegalIgnore,
  type RegalExemption,
} from "@/lib/monitor/regal-calls";
import { regalCallsReachedVerdict } from "@/lib/monitor/verdict-freshness";
import { assert, eq, finish } from "./lib/harness.ts";

const NOW = Date.UTC(2026, 8, 24, 15, 0, 0); // 11:00 ET
const MIN = 60_000;

function user(over: Partial<RegalCaller> = {}): RegalCaller {
  return {
    id: "u-jane",
    name: "Jane Agent",
    email: "jane@trypennie.com",
    role: "agent",
    bookable: false,
    deactivated_at: null,
    is_test: false,
    is_placeholder: false,
    attributes: null,
    ...over,
  };
}
function call(email: string, minutesAgo = 3): RegalCandidate {
  return { agent_email: email, occurred_at: new Date(NOW - minutesAgo * MIN).toISOString() };
}

// --- 1. the decision --------------------------------------------------------

{
  const [v] = judgeRegalCallers([call("jane@trypennie.com")], [user()], []);
  eq(v.exemptions, [], "an agent who is not bookable and placed a call is flagged");
  eq(v.axis, "not-bookable", "the page names the axis: the bookable switch is off");
  eq(v.calls, 1, "one call counted");
}
{
  const [v] = judgeRegalCallers(
    [call("jane@trypennie.com")],
    [user({ bookable: true, deactivated_at: "2026-09-01T00:00:00Z" })],
    [],
  );
  eq(v.axis, "deactivated", "a deactivated agent is named as deactivated, whatever the bookable flag says");
  eq(v.exemptions, [], "a departed employee still placing calls is the finding, not noise");
}

// Every combination of the four exemptions, each asserted present exactly when
// its condition holds, so no reason is ever folded into another.
const combos: { routable: boolean; role: boolean; test: boolean; ignored: boolean }[] = [];
for (let i = 0; i < 16; i++) {
  combos.push({ routable: !!(i & 1), role: !!(i & 2), test: !!(i & 4), ignored: !!(i & 8) });
}
for (const c of combos) {
  const u = user({ bookable: c.routable, role: c.role ? "manager" : "agent", is_test: c.test });
  const ignores: RegalIgnore[] = c.ignored ? [{ user_id: u.id, reason: "works the dialer only" }] : [];
  const [v] = judgeRegalCallers([call(u.email)], [u], ignores);
  const expected: RegalExemption[] = [];
  if (c.routable) expected.push("routable");
  if (c.role) expected.push("role");
  if (c.test) expected.push("test");
  if (c.ignored) expected.push("ignored");
  const label = JSON.stringify(c);
  eq(v.exemptions, expected, `exemptions for ${label} are exactly the ones that hold`);
  eq(v.exemptions.length === 0, !c.routable && !c.role && !c.test && !c.ignored, `flagged only with none, ${label}`);
}
{
  const [v] = judgeRegalCallers([call("left@trypennie.com")], [user()], []);
  eq(v.exemptions, ["not-in-slate"], "an address with no Slate user now is its own reason, never a page");
  eq(v.user, null, "and carries no user");
}
{
  const verdicts = judgeRegalCallers(
    [call("jane@trypennie.com", 20), call("jane@trypennie.com", 2), call("JANE@trypennie.com", 5)],
    [user()],
    [],
  );
  eq(verdicts.length, 1, "several calls from one person are one verdict, matched case insensitively");
  eq(verdicts[0].calls, 3, "and count every call");
  eq(verdicts[0].lastCallMs, NOW - 2 * MIN, "the latest call is the one the page names");
}

// --- 2. the role table is the Role union -------------------------------------

const typesSrc = readFileSync("src/lib/db/types.ts", "utf8");
const roleUnion = /export type Role\s*=\s*([^;]+);/.exec(typesSrc)?.[1] ?? "";
const roles = [...roleUnion.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
assert(roles.length >= 5, `read the Role union (${roles.join(", ")})`);
eq(Object.keys(REGAL_ROLE_EXEMPT).sort(), roles, "the exemption table has exactly one entry per Role");
eq(
  Object.entries(REGAL_ROLE_EXEMPT)
    .filter(([, exempt]) => !exempt)
    .map(([r]) => r),
  ["agent"],
  "every role but agent is exempt (team_lead confirmed by Dan, 2026-09-08)",
);
assert(
  readFileSync("src/lib/monitor/regal-calls.type-test.ts", "utf8").includes("@ts-expect-error"),
  "the type test that makes a sixth role a build failure is in place",
);

// --- 3 and 4. the runner ------------------------------------------------------

interface Sent {
  key: string;
  cooldownMs: number;
  text: string;
}
function harness(over: Partial<Parameters<typeof runRegalCallCheck>[0]> = {}) {
  const pages: Sent[] = [];
  const resolved: { key: string; text: string }[] = [];
  let since = "";
  const deps: Parameters<typeof runRegalCallCheck>[0] = {
    loadCandidates: async (sinceIso) => {
      since = sinceIso;
      return [call("jane@trypennie.com")];
    },
    loadUsers: async () => [user()],
    loadIgnores: async () => [],
    loadFiringUserIds: async () => [],
    armed: true,
    notify: async (key, cooldownMs, text) => {
      pages.push({ key, cooldownMs, text });
    },
    resolve: async (key, text) => {
      resolved.push({ key, text });
      return true;
    },
    cooldownMs: 24 * 60 * MIN,
    nowMs: NOW,
    ...over,
  };
  return { deps, pages, resolved, since: () => since };
}

{
  const h = harness();
  const r = await runRegalCallCheck(h.deps);
  eq(r.status, "checked", "a planted violation is judged");
  eq(h.pages.length, 1, "the detector FIRES on a planted violation");
  eq(h.pages[0].key, regalCallAlertKey("u-jane"), "one page per agent, keyed on the user id");
  eq(h.pages[0].key.startsWith(`${REGAL_CALL_ALERT_PREFIX}:`), true, "under the family prefix");
  eq(h.pages[0].cooldownMs, 24 * 60 * MIN, "on the configured cooldown (24 hours by default)");
  assert(h.pages[0].text.includes("Jane Agent"), "the page names the person");
  eq(h.since(), new Date(NOW - REGAL_CALL_WINDOW_MS).toISOString(), "it reads the recent window on arrival");
  assert(regalCallsReachedVerdict(r), "a judged call is a verdict");
}
{
  const h = harness({ loadIgnores: async () => [{ user_id: "u-jane", reason: "dialer only" }] });
  const r = await runRegalCallCheck(h.deps);
  eq(h.pages.length, 0, "the detector stays quiet on an ignored agent");
  eq(r.status, "checked", "and still reached a verdict: it judged a real call");
  assert(regalCallsReachedVerdict(r), "an ignored caller is still a measured verdict");
}
{
  const h = harness({ armed: false });
  const r = await runRegalCallCheck(h.deps);
  eq(h.pages.length, 0, "disarmed: no page");
  eq(r.status === "checked" ? r.paged : null, false, "and says it did not page, so observed is never read as sent");
  eq(r.status === "checked" ? r.flagged.length : -1, 1, "while still measuring who it would have named");
}
{
  const h = harness({ loadCandidates: async () => [] });
  const r = await runRegalCallCheck(h.deps);
  eq(r.status, "no-calls", "zero candidate events is its own outcome");
  assert(!regalCallsReachedVerdict(r), "and is NOT a verdict: a feed nobody posts to reads exactly like this");
}
for (const which of ["loadCandidates", "loadUsers", "loadIgnores", "loadFiringUserIds"] as const) {
  const h = harness({
    [which]: async () => {
      throw new Error(`${which} refused`);
    },
    loadFiringUserIds: which === "loadFiringUserIds"
      ? async () => {
          throw new Error("loadFiringUserIds refused");
        }
      : async () => ["u-jane"],
    loadUsers: which === "loadUsers"
      ? async () => {
          throw new Error("loadUsers refused");
        }
      : async () => [user({ bookable: true })],
  });
  const r = await runRegalCallCheck(h.deps);
  eq(r.status, "unreadable", `a failed ${which} reports unmeasured`);
  assert(!regalCallsReachedVerdict(r), `a failed ${which} stamps no verdict`);
  eq(h.pages.length, 0, `a failed ${which} pages nobody`);
  eq(h.resolved.length, 0, `a failed ${which} clears nothing, even with a routable agent paged`);
}
{
  // A notify that throws must not take the tick down or skip the next agent.
  const pages: string[] = [];
  const h = harness({
    loadCandidates: async () => [call("jane@trypennie.com"), call("sam@trypennie.com")],
    loadUsers: async () => [user(), user({ id: "u-sam", name: "Sam", email: "sam@trypennie.com" })],
    notify: async (key) => {
      pages.push(key);
      if (key.endsWith("u-jane")) throw new Error("slack down");
    },
  });
  const r = await runRegalCallCheck(h.deps);
  eq(r.status, "checked", "a failed send does not fail the check");
  eq(pages.sort(), [regalCallAlertKey("u-jane"), regalCallAlertKey("u-sam")], "every flagged agent is still tried");
}

// --- 5. the endings ------------------------------------------------------------

{
  const users = [
    user({ id: "u-back", name: "Back", email: "back@trypennie.com", bookable: true }),
    user({ id: "u-ignored", name: "Ignored", email: "ign@trypennie.com" }),
    user({ id: "u-promoted", name: "Promoted", email: "pro@trypennie.com", role: "team_lead" }),
    user({ id: "u-test", name: "Test", email: "t@trypennie.com", is_test: true }),
    user({ id: "u-still", name: "Still", email: "still@trypennie.com" }),
  ];
  const ignores: RegalIgnore[] = [{ user_id: "u-ignored", reason: "dialer only" }];
  const endings = settleRegalCallAlerts(
    ["u-back", "u-ignored", "u-promoted", "u-test", "u-still", "u-gone"],
    users,
    ignores,
  );
  const byId = new Map(endings.map((e) => [e.userId, e.ending]));
  eq(byId.get("u-back"), "routable", "bookable again is the recovery");
  eq(byId.get("u-ignored"), "ignored", "added to the ignore list is the suppression");
  eq(byId.get("u-promoted"), "exempt-role", "a role change is its own ending");
  eq(byId.get("u-test"), "exempt-test", "becoming a test user is its own ending");
  eq(byId.get("u-gone"), "gone", "a user who no longer exists ends the page rather than hanging it");
  assert(!byId.has("u-still"), "somebody still not routable and not exempt keeps their page open");

  const texts = endings.map((e) => e.text);
  eq(new Set(texts.map((t) => t.split(" ").slice(-12).join(" "))).size, texts.length, "no two endings share wording");
  const recovery = endings.find((e) => e.ending === "routable")!.text;
  const suppression = endings.find((e) => e.ending === "ignored")!.text;
  assert(!/not a fix|suppress/i.test(recovery), "the recovery does not call itself a suppression");
  assert(/not a fix/i.test(suppression), "the suppression says it is not a fix");
  assert(suppression.includes("dialer only"), "the suppression quotes the reason it was given");
  assert(/still/i.test(suppression), "the suppression says Slate still does not route to them");
}
{
  const h = harness({
    loadCandidates: async () => [],
    loadFiringUserIds: async () => ["u-jane", "u-sam"],
    loadUsers: async () => [
      user({ bookable: true }),
      user({ id: "u-sam", name: "Sam", email: "sam@trypennie.com" }),
    ],
  });
  await runRegalCallCheck(h.deps);
  eq(h.resolved.map((r) => r.key), [regalCallAlertKey("u-jane")], "a measured tick settles the routable page even with no calls, and only that one");
}
{
  const h = harness({
    armed: false,
    loadFiringUserIds: async () => ["u-jane"],
    loadUsers: async () => [user({ bookable: true })],
  });
  await runRegalCallCheck(h.deps);
  eq(h.resolved.length, 0, "a disarmed tick clears nothing: silence chosen by a switch is not a measurement");
}

// --- copy ------------------------------------------------------------------------

{
  const [v] = judgeRegalCallers([call("jane@trypennie.com", 18)], [user()], []);
  const text = formatRegalCallAlert(v);
  assert(!/^Slate/.test(text), "the page does not open with the word Slate");
  assert(text.includes("jane@trypennie.com"), "the page carries the address");
  assert(text.includes("10:42"), "the call time is rendered in the org's zone");
  assert(/bookable/i.test(text), "the not bookable axis names the switch");
  assert(/ignore list/i.test(text), "the page names both remedies, the ignore list among them");
  const [d] = judgeRegalCallers([call("jane@trypennie.com")], [user({ deactivated_at: "2026-09-01T00:00:00Z" })], []);
  assert(/deactivated/i.test(formatRegalCallAlert(d)), "the deactivated axis says so");
  assert(formatRegalCallAlert(d) !== formatRegalCallAlert(v), "the two axes read differently");
  const gone = formatRegalCallEnding({ userId: "u-x", ending: "gone", user: null, ignoreReason: null });
  assert(!/undefined|null/.test(gone), "an ending with no user renders no placeholder");
}

// --- 6. Redistribute (#2724) ---------------------------------------------------

const TAGGED = { redistribute_tagged: "Y" } as const;
{
  // The fixture that FIRES and the fixture that is exempt differ only in the tag, so
  // an exemption that fired on anything else would fail the first assertion (L159).
  const [flagged] = judgeRegalCallers([call("jane@trypennie.com")], [user()], []);
  eq(flagged.exemptions, [], "positive control: the untagged, switched off agent is flagged");
  const [v] = judgeRegalCallers([call("jane@trypennie.com")], [user({ attributes: { ...TAGGED } })], []);
  eq(v.exemptions, ["redistribute"], "the same agent carrying the Redistribute tag is exempt, reported as redistribute");
}
{
  const [v] = judgeRegalCallers(
    [call("jane@trypennie.com")],
    [user({ attributes: { redistribute: "Y", redistribute_at: "2026-09-10T00:00:00Z" } })],
    [],
  );
  eq(v.exemptions, [], "Slate's own redistribute MARK alone does not exempt: the mirrored tag is the source");
}
{
  const [v] = judgeRegalCallers([call("jane@trypennie.com")], [user({ attributes: { redistribute_tagged: "N" } })], []);
  eq(v.exemptions, [], "only the one spelling of the tag exempts");
}
{
  const [v] = judgeRegalCallers(
    [call("jane@trypennie.com")],
    [user({ deactivated_at: "2026-09-01T00:00:00Z", attributes: { ...TAGGED } })],
    [],
  );
  eq(v.exemptions, [], "a deactivated agent is not exempt by the tag: it explains a switch, not a departure");
}
{
  const [v] = judgeRegalCallers([call("jane@trypennie.com")], [user({ bookable: true, attributes: { ...TAGGED } })], []);
  eq(v.exemptions, ["routable"], "a routable tagged agent is routable, not redistribute: the tag explains only a switch that is off");
}
{
  const h = harness({ loadUsers: async () => [user({ attributes: { ...TAGGED } })] });
  const r = await runRegalCallCheck(h.deps);
  eq(h.pages.length, 0, "no page for a Redistribute agent placing calls");
  eq(r.status === "checked" ? r.exempt.redistribute : -1, 1, "and the exemption is counted under its own name");
  assert(regalCallsReachedVerdict(r), "a judged Redistribute caller is still a measured verdict");
}
{
  // The tag comes off (the sync deletes `redistribute_tagged`) and the agent stays
  // off in Slate: the next call pages again, and an open page is not closed.
  const h = harness({ loadUsers: async () => [user({ attributes: {} })], loadFiringUserIds: async () => ["u-jane"] });
  await runRegalCallCheck(h.deps);
  eq(h.pages.map((p) => p.key), [regalCallAlertKey("u-jane")], "the tag coming off ends the exemption: the next call pages");
  eq(h.resolved.length, 0, "and the open page stays open");
}
{
  const h = harness({
    loadCandidates: async () => [],
    loadFiringUserIds: async () => ["u-jane"],
    loadUsers: async () => [user({ attributes: { ...TAGGED } })],
  });
  await runRegalCallCheck(h.deps);
  eq(h.resolved.length, 1, "an open page for an agent now tagged Redistribute is closed");
  const text = h.resolved[0].text;
  assert(/suppression, not a recovery/i.test(text), "with suppression wording, as the ignore list's ending has");
  assert(/Redistribute/.test(text), "naming the tag as the reason");
  assert(!/routable again/i.test(text), "and never recovery wording");
  eq(
    settleRegalCallAlerts(["u-jane"], [user({ attributes: { ...TAGGED } })], [])[0]?.ending,
    "exempt-redistribute",
    "the ending is its own, not folded into ignored",
  );
  const others = (["routable", "ignored", "exempt-role", "exempt-test", "gone"] as const).map((ending) =>
    formatRegalCallEnding({ userId: "u-jane", ending, user: user(), ignoreReason: "dialer only" }),
  );
  assert(!others.includes(text), "and no other ending shares its sentence");
}
{
  // A failed read of the tag's source. The tag lives on the roster row, so this is
  // the roster read: nothing is cleared and nobody is exempted.
  const h = harness({
    loadFiringUserIds: async () => ["u-jane"],
    loadUsers: async () => {
      throw new Error("users refused");
    },
  });
  const r = await runRegalCallCheck(h.deps);
  eq(r.status, "unreadable", "a failed read of the tag's source is unmeasured");
  eq(h.resolved.length, 0, "and clears nothing, not even a page for somebody who may be tagged");
  eq(h.pages.length, 0, "and pages nobody");
  assert(!("exempt" in r), "and reports no exemption count at all, so nobody reads as exempt");
}
{
  const [v] = judgeRegalCallers([call("jane@trypennie.com")], [user()], []);
  const text = formatRegalCallAlert(v);
  assert(/Redistribute/.test(text), "the not bookable page names the third reason, the Redistribute tag");
}

// --- 7. a tag the roster sync can no longer vouch for (#2735) -------------------
// The sync keeps a row's stored tag when Twilio holds no worker for them (L214), so
// the tag alone would exempt somebody whose worker is gone for as long as it stays
// gone. The sync stamps `twilio_worker_missing_since` instead of clearing anything,
// and the detector refuses the exemption on it and pages with its own wording.

const UNVOUCHED = { redistribute_tagged: "Y", twilio_worker_missing_since: "2026-09-22T14:00:00.000Z" } as const;
{
  // Same fixture as the exempt case in section 6, plus the stamp, so an exemption
  // refused for any other reason would fail the control first (L159).
  const [exempt] = judgeRegalCallers([call("jane@trypennie.com")], [user({ attributes: { ...TAGGED } })], []);
  eq(exempt.exemptions, ["redistribute"], "control: the tagged agent with a worker is exempt");
  const [v] = judgeRegalCallers([call("jane@trypennie.com")], [user({ attributes: { ...UNVOUCHED } })], []);
  eq(v.exemptions, [], "the same agent whose Twilio worker the last sync could not find is NOT exempt");
  eq(v.axis, "not-bookable", "and is still on the bookable axis");
  eq(v.unvouchedRedistribute, true, "with the reason the tag did not count recorded on the verdict");
  eq(exempt.unvouchedRedistribute, false, "which the exempt one does not carry");
}
{
  const [v] = judgeRegalCallers(
    [call("jane@trypennie.com")],
    [user({ attributes: { redistribute_tagged: "Y", twilio_worker_missing_since: "not a date" } })],
    [],
  );
  eq(v.exemptions, [], "an unreadable stamp still refuses the exemption: it fails toward reporting");
  const text = formatRegalCallAlert(v);
  assert(!/NaN|Invalid|undefined|null/.test(text), "and the page renders without a date rather than a broken one");
}
{
  const [v] = judgeRegalCallers([call("jane@trypennie.com")], [user({ attributes: { ...UNVOUCHED } })], []);
  const text = formatRegalCallAlert(v);
  const [plain] = judgeRegalCallers([call("jane@trypennie.com")], [user()], []);
  assert(text !== formatRegalCallAlert(plain), "the page has its own wording, not the untagged agent's");
  assert(/Redistribute/.test(text), "it names the tag it could not trust");
  assert(/no Twilio worker/i.test(text), "and says why: the sync found no Twilio worker for them");
  assert(/Sep 22/.test(text), "and since when, from the stamp");
  assert(!/tag them Redistribute/i.test(text), "and never tells the reader to add a tag they already carry");
}
{
  const h = harness({ loadUsers: async () => [user({ attributes: { ...UNVOUCHED } })] });
  const r = await runRegalCallCheck(h.deps);
  eq(h.pages.map((p) => p.key), [regalCallAlertKey("u-jane")], "a call from them pages");
  eq(r.status === "checked" ? r.exempt.redistribute : -1, 0, "and is not counted as a Redistribute exemption");
  assert(/no Twilio worker/i.test(h.pages[0]?.text ?? ""), "with the wording that names the missing worker");
}
{
  // An open page does not close while the worker is still missing, and closes with
  // the suppression wording once the sync finds it again (the stamp is deleted).
  const still = harness({
    loadCandidates: async () => [],
    loadFiringUserIds: async () => ["u-jane"],
    loadUsers: async () => [user({ attributes: { ...UNVOUCHED } })],
  });
  await runRegalCallCheck(still.deps);
  eq(still.resolved.length, 0, "a page stays open while the tag cannot be vouched for");
  eq(
    settleRegalCallAlerts(["u-jane"], [user({ attributes: { ...TAGGED } })], [])[0]?.ending,
    "exempt-redistribute",
    "and ends as a Redistribute suppression once the worker is back",
  );
}
{
  // Failure path: the roster read, which is where the stamp lives, fails. Nothing
  // is paged or cleared, so an unreadable roster never reads as a missing worker.
  const h = harness({
    loadFiringUserIds: async () => ["u-jane"],
    loadUsers: async () => {
      throw new Error("users refused");
    },
  });
  const r = await runRegalCallCheck(h.deps);
  eq(r.status, "unreadable", "a failed roster read is unmeasured");
  eq(h.pages.length + h.resolved.length, 0, "and pages nothing and clears nothing");
}

// --- 6. the placeholder advisor (#4201) ----------------------------------------
//
// The placeholder holds stacked calls and is never bookable, so a call under its
// address would page every cooldown with nothing for anybody to fix. It is exempt
// under its own name, never folded into the test exemption, and is not offered as
// "becoming a test user" when a page ends.
{
  const marcia = user({ id: "u-marcia", name: "Marcia", email: "marcia@trypennie.com", is_placeholder: true });
  const [v] = judgeRegalCallers([call("marcia@trypennie.com")], [marcia], []);
  eq(v.exemptions, ["placeholder"], "a call under the placeholder's address is exempt as the placeholder");
  const [t] = judgeRegalCallers([call("t@trypennie.com")], [user({ email: "t@trypennie.com", is_test: true, is_placeholder: true })], []);
  eq(t.exemptions, ["test", "placeholder"], "the test placeholder carries both reasons, each its own");

  const [ending] = settleRegalCallAlerts(["u-marcia"], [marcia], []);
  eq(ending?.ending, "exempt-placeholder", "a page on somebody who becomes the placeholder ends as its own ending");
  assert(/placeholder/i.test(ending?.text ?? ""), "and its sentence names the placeholder");
  const others = (["routable", "ignored", "exempt-role", "exempt-test", "exempt-redistribute", "gone"] as const).map(
    (e) => formatRegalCallEnding({ userId: "u-marcia", ending: e, user: marcia, ignoreReason: "dialer only" }),
  );
  assert(!others.includes(ending?.text ?? ""), "and no other ending shares it");
}

finish();
