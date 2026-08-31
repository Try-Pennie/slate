/**
 * The claims the mirror alerts are allowed to make (#1230).
 *
 * `pnpm preview:alerts` is where a person READS this copy; these assertions pin
 * the two things the drift page got factually wrong on 2026-08-03, so neither can
 * come back:
 *
 *   - it guessed a cause ("the export lane may be lagging or failing") that the
 *     check does not measure. The per-table reason now says which cause was
 *     measured, so the wrapper must not overrule it with a guess (LESSONS L11).
 *   - it said "deletion (when built) must not run until this clears". Deletion
 *     moved off this comparison to the export-lag signal in #1139, and it IS
 *     built, so the sentence sent the reader after the wrong lane (L32/L36).
 */

import { describe, expect, it } from "vitest";
import {
  erasureResidualAlert,
  erasureResidualTestNotice,
  snowflakeDriftAlert,
  snowflakeDriftRecovery,
} from "./alert-copy";

describe("snowflakeDriftAlert", () => {
  const text = snowflakeDriftAlert([
    "audit_log: Snowflake is behind by 251 rows (27/278) and the export lane is current",
  ]);

  it("carries the measured reason", () => {
    expect(text).toContain("audit_log: Snowflake is behind by 251 rows (27/278)");
  });

  it("does not guess at a cause the reason already names", () => {
    expect(text).not.toMatch(/may be lagging or failing/);
  });

  it("does not claim this comparison gates deletion (it stopped in #1139)", () => {
    expect(text).not.toMatch(/when built/);
    expect(text).not.toMatch(/deletion .{0,40}must not run until this clears/);
  });

  it("leaves the remedy to the reason, which is the part that knows the cause", () => {
    // A positive-control failure ("the warehouse count cannot be trusted") reaches
    // this same wrapper. A tail that talks about re-exporting stranded rows would
    // hand that reader a remedy for a problem they do not have (L36).
    expect(text).not.toMatch(/reexport/);
    expect(text).not.toMatch(/catches itself up/);
  });

  it("still says the one standing fact a reader would otherwise get wrong", () => {
    // Namely that retention deletion does NOT hang off this comparison, which is
    // what the old sentence implied.
    expect(text).toMatch(/gated on the export lag reading, not on this comparison/);
  });
});

describe("snowflakeDriftRecovery", () => {
  const text = snowflakeDriftRecovery();

  it("only claims the counts agree again, which is all the lane measures", () => {
    expect(text).toMatch(/matches the live database again/);
    expect(text).toMatch(/No action is needed/);
  });

  it("does not claim the export lane caught up, which it may never have been behind on", () => {
    // The drift it clears may have been rows stranded behind the watermark and
    // fixed by a re-export, with the lane current the whole time.
    expect(text).not.toMatch(/caught up/);
  });
});

/**
 * The residual page has to be ACTIONABLE (#1195) and has to say which KIND of
 * residual it found (#1196).
 *
 * Both were filed off one live page on 2026-07-31 that reported `bookings: 1,
 * booking_events: 1, webhook_deliveries: 3` and then sent the reader to a runbook.
 * It named no booking, so identifying the subject took a query against
 * `audit_log`; and it read identically whether the subject was a real person's
 * incomplete erasure (a compliance incident with a clock on it) or the retired
 * SMOKE fixture (an operational tidy-up on fake data), which it was.
 *
 * The remedy sentence is the part that had gone stale. #1128 replaced the four
 * hand-pasted statements with an endpoint and #1124 put a worklist on top of it,
 * so pointing at the runbook names a procedure instead of the action that
 * actually changes the state the reader is stuck in (L111).
 */
describe("erasureResidualAlert", () => {
  const text = erasureResidualAlert(["bookings: 1 row still holds contact PII"], ["bk-1", "bk-2"]);

  it("names the bookings, which is the one fact the purge needs", () => {
    expect(text).toContain("bk-1");
    expect(text).toContain("bk-2");
  });

  it("sends the reader to the worklist, which is where the purge actually happens", () => {
    expect(text).toContain("/admin/erasure");
  });

  it("does not send the reader to the runbook to paste SQL by hand", () => {
    expect(text).not.toMatch(/pii-erasure-runbook/);
  });

  it("truncates a large batch rather than printing a wall of ids", () => {
    const many = Array.from({ length: 12 }, (_, i) => `bk-${i + 1}`);
    const long = erasureResidualAlert(["bookings: 12 rows still hold contact PII"], many);
    expect(long).toContain("bk-1");
    expect(long).toMatch(/7 more/);
    // The whole point of truncating: the untruncated form is unreadable on a phone.
    expect(long).not.toContain("bk-12");
  });

  it("says nothing about ids when it was given none, rather than an empty list", () => {
    const none = erasureResidualAlert(["bookings: 1 row still holds contact PII"], []);
    expect(none).not.toMatch(/bookings?:\s*\./);
    expect(none).not.toMatch(/\(\)/);
  });
});

describe("erasureResidualTestNotice", () => {
  const text = erasureResidualTestNotice(["booking_outbox: 1 row still holds contact PII"], ["bk-smoke"]);

  it("says the data is synthetic, so triage is instant", () => {
    expect(text).toMatch(/test/i);
  });

  it("still names the bookings and the place to clear them", () => {
    expect(text).toContain("bk-smoke");
    expect(text).toContain("/admin/erasure");
  });

  it("does not describe itself as urgent, because nothing is exposed", () => {
    expect(text).not.toMatch(/incident|urgent|immediately/i);
  });
});
