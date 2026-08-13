// #1476/#1477: the admin time off page names a problem it will not let you read,
// and a repair that reports nothing.
//
// The red "calendar updates incomplete" marker carried WHICH step failed only in
// a title attribute, so on a phone the page states there is a problem and offers
// no way to see what it is (L49, L80). And the retry set no banner at all, so a
// retry that fixed everything, one that fixed some steps and one that fixed
// nothing looked identical: on 2026-08-13 the person who pressed it had to ask
// someone else to query the database before he knew whether the calendar event
// had landed.
//
// Both surfaces are built from the SAME description of the request's finished
// state (L78: report from the state, not from the path that ran), so the panel
// and the banner can never disagree about which steps are in place.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-ooo-effect-copy.ts
import {
  EFFECT_LABELS,
  describeEffects,
  retryOutcome,
} from "../src/lib/ooo/effect-copy.ts";
import { EFFECTS } from "../src/lib/ooo/orchestration.ts";
import { assert, finish } from "./lib/harness.ts";

// --- every effect key the orchestration can write has a human label ----------
// Derived from EFFECTS rather than a hand-kept list, because a table keyed by a
// vocabulary silently takes its default branch for the entry somebody forgot,
// and a default is indistinguishable from a deliberate choice (L113).
{
  for (const key of Object.values(EFFECTS)) {
    assert(
      typeof EFFECT_LABELS[key] === "string" && EFFECT_LABELS[key].length > 0,
      `effect "${key}" has a human label`,
    );
  }
  assert(
    Object.keys(EFFECT_LABELS).every((k) => (Object.values(EFFECTS) as string[]).includes(k)),
    "no label names an effect nothing writes",
  );
  assert(
    new Set(Object.values(EFFECT_LABELS)).size === Object.keys(EFFECT_LABELS).length,
    "each step reads as itself, so two failures are never described identically",
  );
}

// --- describeEffects: what is in place, what is not --------------------------
{
  const d = describeEffects({
    manager_event: "ok",
    agent_event: "failed: AbortError: The operation was aborted",
    busy_block: "ok (slate fallback)",
    calcom: "skipped: not in cal.com (a@trypennie.com)",
  });

  assert(d.failed.length === 1, "one failed step");
  assert(d.failed[0].key === "agent_event", "names the step that failed");
  assert(d.failed[0].label === EFFECT_LABELS.agent_event, "uses the human label");
  assert(
    d.failed[0].reason !== null && d.failed[0].reason.includes("aborted"),
    "carries a short reason a person can act on",
  );
  assert(
    d.done.some((s) => s.key === "busy_block"),
    'a step recorded "ok (slate fallback)" counts as in place',
  );
  assert(
    !d.done.some((s) => s.key === "calcom"),
    "a skip is not a completed step, so it is not claimed as one",
  );
  assert(
    d.skipped.some((s) => s.key === "calcom"),
    "a skip is reported as its own outcome rather than vanishing",
  );
}

{
  // A request with nothing recorded yet: no failures invented, nothing claimed.
  const d = describeEffects(null);
  assert(d.failed.length === 0 && d.done.length === 0, "an empty record claims nothing");
}

{
  // An effect key nobody has a label for must still be readable, and must be
  // reported: dropping it would hide the one failure the reader needs most.
  const d = describeEffects({ some_new_step: "failed: boom" });
  assert(d.failed.length === 1, "an unlabelled step is still reported");
  assert(d.failed[0].label.length > 0, "an unlabelled step still renders a name");
}

// --- retryOutcome: what the repair actually did ------------------------------
{
  // Everything landed. The banner says so plainly.
  const r = retryOutcome({ manager_event: "ok", agent_event: "ok", busy_block: "ok" });
  assert(r.ok !== null, "a fully repaired retry reports success");
  assert(r.msg === null, "a fully repaired retry raises no warning");
  assert(/in place|complete/i.test(r.ok as string), "the success line says the work is done");
}

{
  // Partly repaired. The banner NAMES what is still failing, so the reader does
  // not have to guess whether pressing it again would help.
  const r = retryOutcome({
    manager_event: "ok",
    agent_event: "failed: no calendar access",
    busy_block: "ok",
  });
  assert(r.ok === null, "a partial repair is not reported as success");
  assert(r.msg !== null, "a partial repair warns");
  assert(
    (r.msg as string).includes(EFFECT_LABELS.agent_event),
    "the warning names the step that is still failing",
  );
  assert(
    !(r.msg as string).includes(EFFECT_LABELS.manager_event),
    "the warning does not name a step that is fine",
  );
}

{
  // Two still failing: both named, so a second retry is an informed choice.
  const r = retryOutcome({
    manager_event: "failed: no access",
    agent_event: "failed: no calendar access",
  });
  assert(
    (r.msg as string).includes(EFFECT_LABELS.agent_event) &&
      (r.msg as string).includes(EFFECT_LABELS.manager_event),
    "every still-failing step is named",
  );
}

{
  // Copy rules, on every shape the banner and the panel can take.
  const texts = [
    retryOutcome({ agent_event: "ok" }).ok,
    retryOutcome({ agent_event: "failed: no calendar access" }).msg,
    ...describeEffects({ agent_event: "failed: no calendar access" }).failed.map(
      (f) => `${f.label}: ${f.reason}`,
    ),
  ].filter((t): t is string => t !== null);
  assert(texts.length >= 3, "there is something to check");
  for (const t of texts) {
    assert(!/[\u2014\u2013]/.test(t), `no dash punctuation: ${t}`);
    assert(!/undefined|NaN|\[object/.test(t), `nothing leaks: ${t}`);
    assert(!/\bfailed:/.test(t), `the raw stored prefix is not shown to a person: ${t}`);
  }
}

finish();
