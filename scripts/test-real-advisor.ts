// The shared real advisor rule (#4201): the query helpers apply the exclusions
// they name, and the predicate reads an absent flag as the column default.
// Run: node --experimental-strip-types scripts/test-real-advisor.ts
import {
  isRealAdvisor,
  realAdvisorsOnly,
  REAL_ADVISOR_COLUMNS,
  withoutPlaceholder,
} from "../src/lib/advisors/real-advisor.ts";
import { eq, finish } from "./lib/harness.ts";

/** A builder that records its filters and applies them to rows, as PostgREST would. */
class Recorder {
  filters: [string, boolean][] = [];
  eq(column: string, value: boolean): Recorder {
    this.filters.push([column, value]);
    return this;
  }
  run(rows: Record<string, unknown>[]): string[] {
    return rows.filter((r) => this.filters.every(([c, v]) => r[c] === v)).map((r) => String(r.id));
  }
}

const ROWS = [
  { id: "real", is_test: false, is_placeholder: false },
  { id: "smoke", is_test: true, is_placeholder: false },
  { id: "marcia", is_test: false, is_placeholder: true },
  { id: "marcia-test", is_test: true, is_placeholder: true },
];

{
  const q = realAdvisorsOnly(new Recorder());
  eq(q.filters, [["is_test", false], ["is_placeholder", false]], "realAdvisorsOnly filters both flags");
  eq(q.run(ROWS), ["real"], "and keeps only the real advisor");
}
{
  const q = withoutPlaceholder(new Recorder());
  eq(q.filters, [["is_placeholder", false]], "withoutPlaceholder filters only the placeholder flag");
  eq(q.run(ROWS), ["real", "smoke"], "so the smoke advisors stay and both placeholders go");
}

eq(
  ROWS.filter(isRealAdvisor).map((r) => r.id),
  ["real"],
  "the predicate agrees with the query helper on every kind of row",
);
eq(isRealAdvisor({}), true, "absent flags read as the column default, false");
eq(isRealAdvisor({ is_test: null, is_placeholder: null }), true, "so do null flags");
eq(isRealAdvisor({ is_placeholder: true }), false, "a placeholder read without is_test is still refused");
eq(REAL_ADVISOR_COLUMNS, "is_test, is_placeholder", "the column list names both flags the predicate reads");

finish();
