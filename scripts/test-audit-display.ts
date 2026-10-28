// Display logic for the admin audit trail: the action label, who took it, and
// the one-line detail. Pure, so it is tested here rather than through the page.
//
// It exists because of #1220. That bug left every ooo.* action unrecorded, and
// the 269 rows rebuilt from ooo_requests afterwards must be readable as REBUILT:
// an audit row that silently claims to have been written at the time is worse
// than a visible gap. The table also fell back to printing raw action strings
// ("ooo.approve") for every action nobody had added a label for.
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-audit-display.ts
import {
  auditActionLabel,
  auditActorText,
  auditDetailText,
  isReconstructed,
} from "../src/lib/audit-display.ts";
import { AUDIT_ACTIONS } from "../src/lib/audit.ts";
import { assert, eq, finish } from "./lib/harness.ts";

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

  // Completeness, enumerated from the ACTUAL vocabulary rather than a second hand
  // list. The assertions above are a hand list sitting beside the label map, and a
  // hand list cannot see an action missing from BOTH itself and the map: that action
  // just falls back to its raw key and renders as "org.business_hours" to whoever
  // reads the trail, with nothing failing. Walking AUDIT_ACTIONS closes that.
  for (const action of AUDIT_ACTIONS) {
    assert(
      auditActionLabel(action) !== action,
      `every action Slate can write has a readable label (${action} does not)`,
    );
  }
  // Positive control: the loop must be able to fail, i.e. it really enumerated the
  // vocabulary rather than walking an empty list.
  assert(
    AUDIT_ACTIONS.length > 15,
    `the vocabulary really was enumerated (${AUDIT_ACTIONS.length} actions)`,
  );
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

// --- #3615: a call the demotion automation moved ---
{
  const row = (change: unknown) => ({
    action: "booking.demotion_reroute",
    actor_id: null,
    details: { booking_id: "bk1", from_user_id: "out", to_user_id: "cov", change },
  });
  const change = {
    from: { debtTeam: ["ultra_high", "high"], backendService: ["achieve"] },
    to: { debtTeam: ["high"], backendService: ["achieve"] },
  };
  // No person pressed anything, and "unassigned" would read as nobody being responsible.
  assert(auditActorText(row(change), nameOf) === "Slate", "the automation's move is attributed to Slate, not 'unassigned'");
  assert(auditActionLabel("booking.demotion_reroute") === "moved a booked call after a Twilio demotion", "labelled as what happened");
  const detail = auditDetailText(row(change), nameOf);
  assert(
    detail === "Moved to Name(cov). Debt tiers went from Ultra High and High to High.",
    `the detail names who took the call and what changed (${detail})`,
  );
  const both = auditDetailText(
    row({ from: { debtTeam: ["high"], backendService: ["achieve"] }, to: { debtTeam: ["high"], backendService: [] } }),
    nameOf,
  );
  assert(both === "Moved to Name(cov). Backend went from Achieve to none.", `a backend change is named on its own (${both})`);
  const unrecorded = auditDetailText(row(null), nameOf);
  assert(
    unrecorded === "Moved to Name(cov). What changed in Twilio was not recorded.",
    `an unrecorded change says so rather than inventing one (${unrecorded})`,
  );
  assert(!/[\u2014\u2013]/.test(detail), "the detail has no dash punctuation");

  // A row with no destination recorded must not read "Moved to unassigned".
  const noTo = auditDetailText({ ...row(change), details: { booking_id: "bk1", change } }, nameOf);
  assert(noTo.startsWith("Moved to another advisor."), `a missing destination reads as another advisor (got: ${noTo})`);

  // The change comes back from jsonb. A malformed one must read as unrecorded, never throw while
  // the page renders and take the whole audit log down with it (L50).
  for (const bad of [{ from: "x" }, { from: { debtTeam: "high" }, to: {} }, "garbage", 7, { from: null, to: null }]) {
    let text = "";
    try {
      text = auditDetailText(row(bad), nameOf);
    } catch (err) {
      text = `THREW ${String(err)}`;
    }
    assert(
      text === "Moved to Name(cov). What changed in Twilio was not recorded.",
      `a malformed stored change (${JSON.stringify(bad)}) reads as unrecorded (got: ${text})`,
    );
  }
}

// --- #3615: an admin moved an automatically moved call back ---
{
  const row = {
    action: "booking.demotion_reroute_reverted",
    actor_id: "admin1",
    details: { booking_id: "bk1", from_user_id: "cov", to_user_id: "out" },
  };
  eq(auditActorText(row, nameOf), "Name(admin1)", "attributed to the admin who pressed it");
  eq(auditDetailText(row, nameOf), "Moved back to Name(out) from Name(cov).", "naming both advisors");
}

// --- #4299: a reminder email test send Gmail never answered for ---
{
  const sent = { action: "reminder_email.test_sent", actor_id: "admin1", details: { sample_call: "calling_known", gmail: "accepted" } };
  eq(auditDetailText(sent), "", "a confirmed test send adds nothing to its label");
  const unconfirmed = { ...sent, details: { ...sent.details, gmail: "unconfirmed" } };
  assert(/may not have arrived/.test(auditDetailText(unconfirmed)), "an unconfirmed test send says it may not have arrived");
}

finish();
