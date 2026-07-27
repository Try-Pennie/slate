import { describe, expect, it } from "vitest";
import { buildMergeSql, formatValue, type ColSpec } from "./merge";

describe("formatValue", () => {
  it("renders null/undefined/empty-string as NULL", () => {
    expect(formatValue(null, "varchar")).toBe("NULL");
    expect(formatValue(undefined, "number")).toBe("NULL");
    expect(formatValue("", "varchar")).toBe("NULL");
  });

  it("quotes and escapes varchar", () => {
    expect(formatValue("O'Brien", "varchar")).toBe("'O''Brien'");
  });

  it("emits bare numbers and guards non-numeric as NULL", () => {
    expect(formatValue(42, "number")).toBe("42");
    expect(formatValue("7", "number")).toBe("7");
    expect(formatValue("not-a-number", "number")).toBe("NULL");
  });

  it("maps truthy/falsy shapes to TRUE/FALSE", () => {
    expect(formatValue(true, "boolean")).toBe("TRUE");
    expect(formatValue("true", "boolean")).toBe("TRUE");
    expect(formatValue(1, "boolean")).toBe("TRUE");
    expect(formatValue(false, "boolean")).toBe("FALSE");
    expect(formatValue("no", "boolean")).toBe("FALSE");
  });

  it("casts timestamps to the matching Snowflake type", () => {
    expect(formatValue("2026-07-24T12:00:00Z", "timestamp_tz")).toBe("'2026-07-24T12:00:00Z'::TIMESTAMP_TZ");
    expect(formatValue("2026-07-24T12:00:00", "timestamp_ntz")).toBe("'2026-07-24T12:00:00'::TIMESTAMP_NTZ");
  });

  it("serializes a variant as an escaped JSON string (PARSE_JSON is applied in the projection)", () => {
    expect(formatValue({ a: 1, b: "x" }, "variant")).toBe(`'{"a":1,"b":"x"}'`);
    expect(formatValue(["u1", "u2"], "variant")).toBe(`'["u1","u2"]'`);
  });
});

describe("buildMergeSql", () => {
  const cols: ColSpec[] = [
    { name: "id", type: "varchar" },
    { name: "status", type: "varchar" },
    { name: "routing_trace", type: "variant" },
    { name: "created_at", type: "timestamp_tz" },
  ];

  const sql = buildMergeSql("bookings", cols, [
    { id: "b1", status: "confirmed", routing_trace: { chosen_user_id: "u1" }, created_at: "2026-07-24T00:00:00Z" },
  ]);

  it("merges by id", () => {
    expect(sql).toContain("MERGE INTO bookings t");
    expect(sql).toContain("ON t.id = s.id");
  });

  it("wraps variant columns in PARSE_JSON in the projection", () => {
    expect(sql).toContain("PARSE_JSON(routing_trace) AS routing_trace");
    // Non-variant columns are projected bare.
    expect(sql).toMatch(/SELECT [^)]*\bstatus\b/);
  });

  it("updates every column except the id join key", () => {
    expect(sql).toContain("WHEN MATCHED THEN UPDATE SET");
    expect(sql).toContain("status = s.status");
    expect(sql).toContain("routing_trace = s.routing_trace");
    // id must not appear in the UPDATE SET clause.
    const updateClause = sql.split("WHEN MATCHED THEN UPDATE SET")[1].split("WHEN NOT MATCHED")[0];
    expect(updateClause).not.toContain("id = s.id");
  });

  it("inserts the full column tuple when unmatched", () => {
    expect(sql).toContain("WHEN NOT MATCHED THEN INSERT (id, status, routing_trace, created_at, exported_at)");
    expect(sql).toContain("VALUES (s.id, s.status, s.routing_trace, s.created_at, SYSDATE())");
  });

  it("stamps exported_at with the warehouse load time on both branches (#1116)", () => {
    // SYSDATE() is UTC TIMESTAMP_NTZ, matching the column type with no
    // dependence on the session time zone (CURRENT_TIMESTAMP() would be LTZ).
    expect(sql).toContain("exported_at = SYSDATE()");
    expect(sql).toContain("WHEN NOT MATCHED THEN INSERT (id, status, routing_trace, created_at, exported_at)");
    expect(sql).toContain("VALUES (s.id, s.status, s.routing_trace, s.created_at, SYSDATE())");
  });

  it("never sources exported_at from the row, so a stale supabase value cannot land", () => {
    const withStamp = buildMergeSql("bookings", cols, [
      {
        id: "b1",
        status: "confirmed",
        routing_trace: null,
        created_at: "2026-07-24T00:00:00Z",
        // A caller (or a future column addition) handing us an exported_at must
        // be ignored: the stamp is the warehouse's, not the source's.
        exported_at: "1999-01-01T00:00:00Z",
      },
    ]);
    expect(withStamp).not.toContain("1999-01-01");
    expect(withStamp).not.toContain("s.exported_at");
    // exported_at is not a source column, so it stays out of the tuple alias
    // and the USING projection.
    const using = withStamp.split("USING (")[1].split(") s")[0];
    expect(using).not.toContain("exported_at");
  });

  it("escapes single quotes in variant JSON so it cannot break out of the VALUES literal", () => {
    const evil = buildMergeSql("audit_log", [{ name: "id", type: "varchar" }, { name: "details", type: "variant" }], [
      { id: "a1", details: { note: "O'Brien" } },
    ]);
    // The single quote inside the JSON is doubled, so it stays inside the literal.
    // (Backslash doubling is covered by escapeSqlLiteral's own unit test.)
    expect(evil).toContain(`'{"note":"O''Brien"}'`);
  });
});
