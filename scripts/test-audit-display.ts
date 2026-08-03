// Display logic for the admin audit trail: the action label, who took it, and
// the one-line detail. Pure, so it is tested here rather than through the page.
//
// It exists because of #1220. That bug left every ooo.* action unrecorded, and
// the 269 rows rebuilt from ooo_requests afterwards must be readable as REBUILT:
// an audit row that silently claims to have been written at the time is worse
// than a visible gap. The table also fell back to printing raw action strings
// ("ooo.approve") for every action nobody had added a label for.
// Run: node --experimental-strip-types scripts/test-audit-display.ts
import {
  auditActionLabel,
  auditActorText,
  auditDetailText,
  isReconstructed,
} from "../src/lib/audit-display.ts";
import { assert, finish } from "./lib/harness.ts";

const nameOf = (id: string | null) => (id ? `Name(${id})` : "unassigned");

// --- labels: every action Slate can write reads as a phrase, never a key ---
{
  assert(auditActionLabel("role.set") === "changed role", "existing label kept");
  assert(auditActionLabel("ooo.approve") === "approved time off", "ooo.approve labelled");
  assert(auditActionLabel("ooo.reject") === "declined time off", "ooo.reject labelled");
  assert(auditActionLabel("ooo.cancel") === "cancelled time off", "ooo.cancel labelled");
  assert(auditActionLabel("ooo.submit") === "requested time off", "ooo.submit labelled");
  assert(auditActionLabel("ooo.modify") === "changed a time off request", "ooo.modify labelled");
  assert(auditActionLabel("ooo.retry") === "retried time off updates", "ooo.retry labelled");
  assert(
    auditActionLabel("impersonate.start") === "started viewing as another user",
    "impersonate.start labelled",
  );
  // The fallback still has to be the raw action: an unlabelled row must remain
  // readable rather than rendering blank.
  assert(auditActionLabel("some.future") === "some.future", "unknown action falls back to its key");
}

// --- actor: a reconstructed row whose actor was never stored says so ---
{
  const rebuiltCancel = {
    action: "ooo.cancel",
    actor_id: null,
    details: { reconstructed: true, actor_not_recorded: true },
  };
  assert(
    auditActorText(rebuiltCancel, nameOf) === "not recorded",
    "an unrecorded actor is not called 'unassigned'",
  );

  // A null actor that is NOT flagged unrecorded is an operator process, which
  // the existing wording already covers.
  const operator = { action: "pii.erasure", actor_id: null, details: {} };
  assert(auditActorText(operator, nameOf) === "unassigned", "other null actors unchanged");

  const normal = { action: "role.set", actor_id: "u1", details: {} };
  assert(auditActorText(normal, nameOf) === "Name(u1)", "a real actor resolves to their name");
}

// --- detail line ---
{
  const roleChange = {
    action: "role.set",
    actor_id: "u1",
    details: { from: "agent", to: "manager" },
  };
  assert(
    auditDetailText(roleChange).includes("agent") && auditDetailText(roleChange).includes("manager"),
    "role change still shows from and to",
  );

  const rebuilt = {
    action: "ooo.approve",
    actor_id: "u1",
    details: { reconstructed: true, ooo_request_id: "r1" },
  };
  assert(isReconstructed(rebuilt), "a reconstructed row is detected");
  assert(
    auditDetailText(rebuilt).toLowerCase().includes("rebuilt"),
    "a reconstructed row SAYS it was rebuilt",
  );

  const live = { action: "ooo.approve", actor_id: "u1", details: { ooo_request_id: "r1" } };
  assert(!isReconstructed(live), "a live row is not marked reconstructed");
  assert(
    !auditDetailText(live).toLowerCase().includes("rebuilt"),
    "a live row is never labelled rebuilt",
  );

  // The flag arrives from jsonb, so it must survive a string "true" and must not
  // be fooled by a missing or falsy value.
  assert(
    isReconstructed({ action: "x", actor_id: null, details: { reconstructed: "true" } }),
    "string true from jsonb counts",
  );
  assert(
    !isReconstructed({ action: "x", actor_id: null, details: { reconstructed: false } }),
    "explicit false does not count",
  );
  assert(
    !isReconstructed({ action: "x", actor_id: null, details: {} }),
    "absent flag does not count",
  );
}

// --- copy rule: no dashes as punctuation anywhere in this surface ---
{
  const actions = [
    "role.set",
    "ooo.submit",
    "ooo.approve",
    "ooo.reject",
    "ooo.cancel",
    "ooo.modify",
    "ooo.retry",
    "impersonate.start",
    "impersonate.stop",
    "agent.deactivate",
  ];
  // Escaped so this file holds no literal dash for the style hook to catch.
  const dash = /[\u2014\u2013]/;
  for (const a of actions) {
    assert(!dash.test(auditActionLabel(a)), `${a} label has no dash punctuation`);
  }
  assert(
    !dash.test(auditDetailText({ action: "ooo.approve", actor_id: "u", details: { reconstructed: true } })),
    "rebuilt note has no dash punctuation",
  );
}

finish();
