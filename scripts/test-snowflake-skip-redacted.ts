// #1118: the ONE skip predicate that both the export fetch and the reconcile
// count must share. A row whose PII was redacted in place must (a) stop being
// re-exported, so Snowflake freezes at the last full-fidelity version, and (b)
// be excluded from the reconcile Supabase count, so a redacted or early-erased
// row never reads as permanent "Snowflake is behind" drift (which would jam the
// retention lane). Defining it once here is what keeps those two call sites from
// drifting apart. This guards the per-table filter shape.
//
// Run: node --experimental-strip-types scripts/test-snowflake-skip-redacted.ts
import { assert, eq, finish } from "./lib/harness.ts";
import { applySkipRedacted } from "../src/lib/snowflake/skip-redacted.ts";

interface Call {
  method: "is" | "eq";
  args: unknown[];
}
function fakeBuilder() {
  const calls: Call[] = [];
  const b = {
    calls,
    is(col: string, val: null) {
      calls.push({ method: "is", args: [col, val] });
      return b;
    },
    eq(col: string, val: boolean) {
      calls.push({ method: "eq", args: [col, val] });
      return b;
    },
  };
  return b;
}

// bookings: exclude rows redacted in place (pii_redacted_at IS NULL).
{
  const b = fakeBuilder();
  const out = applySkipRedacted("bookings", b);
  eq(b.calls.length, 1, "bookings applies exactly one skip filter");
  eq(b.calls[0].method, "is", "bookings uses .is() (IS NULL, not equality)");
  eq(b.calls[0].args[0], "pii_redacted_at", "bookings filters on pii_redacted_at");
  eq(b.calls[0].args[1], null, "bookings keeps only pii_redacted_at IS NULL");
  assert(out === b, "bookings returns the chained builder");
}

// webhook_deliveries: exclude blanked payloads (payload_erased = false).
{
  const b = fakeBuilder();
  const out = applySkipRedacted("webhook_deliveries", b);
  eq(b.calls.length, 1, "webhook_deliveries applies exactly one skip filter");
  eq(b.calls[0].method, "eq", "webhook_deliveries uses .eq()");
  eq(b.calls[0].args[0], "payload_erased", "webhook_deliveries filters on payload_erased");
  eq(b.calls[0].args[1], false, "webhook_deliveries keeps only payload_erased = false");
  assert(out === b, "webhook_deliveries returns the chained builder");
}

// A table with no in-place redaction is left untouched (no filter, same builder).
for (const table of ["audit_log", "booking_events", "routing_decisions", "booking_outbox"]) {
  const b = fakeBuilder();
  const out = applySkipRedacted(table, b);
  eq(b.calls.length, 0, `${table} applies no skip filter`);
  assert(out === b, `${table} returns the builder unchanged`);
}

finish();
