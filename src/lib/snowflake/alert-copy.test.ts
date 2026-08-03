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
import { snowflakeDriftAlert, snowflakeDriftRecovery } from "./alert-copy";

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
