// The one judge that decides whether a users row may ACT (#2378), pure.
//
// Its wiring is covered where each caller lives (src/lib/auth.test.ts, the Slack
// interactivity route test, src/lib/provision.test.ts). This file pins the
// decision itself, and in particular the two properties a wiring test reads past:
// that every outcome the type ENUMERATES is producible (L151), and that an
// unreadable row refuses rather than admits (L42).
//
// Run: node --experimental-strip-types scripts/test-active-session-gate.ts
import {
  gateSessionRow,
  isDeactivated,
  DeactivatedAccountError,
  PlaceholderAccountError,
  type SessionGate,
} from "../src/lib/auth/active-session.ts";
import type { User } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const LEFT = "2026-09-01T00:00:00.000Z";

const row = (extra: Partial<User> = {}): User =>
  ({
    id: "u1",
    org_id: "org-1",
    auth_user_id: "auth-1",
    email: "someone@trypennie.com",
    name: "Someone",
    role: "manager",
    google_sub: null,
    avatar_url: null,
    attributes: {},
    bookable: true,
    deactivated_at: null,
    last_synced_at: null,
    manager_id: null,
    ...extra,
  }) as User;

const reason = (g: SessionGate): string => (g.admit ? "admitted" : g.reason);

// The positive control comes FIRST and in the same fixture as the refusals below
// (L159): every refusal here is the same row with one field moved, so a judge
// wired to refuse everything cannot pass this file.
const live = gateSessionRow(row(), null);
assert(live.admit, "an active row is admitted");
assert(live.admit && live.user.id === "u1", "the admitted row is handed back whole");

eq(reason(gateSessionRow(row({ deactivated_at: LEFT }), null)), "deactivated", "a departed row is refused as deactivated");
eq(reason(gateSessionRow(null, null)), "no-row", "no row at all is refused as no-row");
eq(reason(gateSessionRow(null, { message: "connection reset" })), "unreadable", "a read error is refused as unreadable");
// #4205: the placeholder advisor (Marcia, #4200) is an account nobody may act as. It
// holds real customers' calls, so a session on it could cancel or move every one.
eq(reason(gateSessionRow(row({ is_placeholder: true }), null)), "placeholder", "the placeholder advisor's row is refused");
eq(
  reason(gateSessionRow(row({ is_placeholder: true, deactivated_at: LEFT }), null)),
  "deactivated",
  "a departed placeholder is reported as departed, the settled answer either way",
);

// FAIL CLOSED both ways an error can arrive. A driver that returns an error
// ALONGSIDE a row must not have the row answer for the error: the whole point of
// the gate is that "I could not tell" refuses.
eq(
  reason(gateSessionRow(row(), { message: "connection reset" })),
  "unreadable",
  "an error beside a live row still refuses (the error is consulted first)",
);
eq(
  reason(gateSessionRow(row({ deactivated_at: LEFT }), { message: "connection reset" })),
  "unreadable",
  "an error beside a departed row is reported as unreadable, not as deactivated",
);

// Every outcome the type enumerates is reachable, so none of them is a branch
// nothing can produce (L151).
const produced = new Set([
  reason(gateSessionRow(row(), null)),
  reason(gateSessionRow(row({ deactivated_at: LEFT }), null)),
  reason(gateSessionRow(null, null)),
  reason(gateSessionRow(null, { message: "x" })),
  reason(gateSessionRow(row({ is_placeholder: true }), null)),
]);
eq(produced.size, 5, "all five outcomes are producible and distinct");

// The stamp is what decides, not truthiness of the field being present.
assert(isDeactivated({ deactivated_at: LEFT }), "a stamped row has left");
assert(!isDeactivated({ deactivated_at: null }), "a null stamp has not left");
assert(!isDeactivated({}), "a row selected without the column reads as still here");
assert(!isDeactivated(null), "no row is not a departure");

// undefined is how supabase-js reports "no error" on some paths; it must not be
// mistaken for an error and refuse a live session.
assert(gateSessionRow(row(), undefined).admit, "an undefined error is not an error");

const err = new DeactivatedAccountError();
assert(err instanceof Error, "the sign in refusal is an Error");
assert(err.name === "DeactivatedAccountError", "and carries its own name, so the callback can tell it from a retryable refusal");

const placeholderErr = new PlaceholderAccountError();
assert(placeholderErr instanceof Error, "the placeholder sign in refusal is an Error");
assert(placeholderErr.name === "PlaceholderAccountError", "with its own name, so the callback can say it plainly");

finish();
