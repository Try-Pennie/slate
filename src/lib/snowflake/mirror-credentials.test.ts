import { describe, it, expect } from "vitest";
import {
  MIRROR_CREDENTIALS,
  redactMirrorCredentials,
  buildCredentialBlankStatements,
  buildCredentialResidualStatement,
  CREDENTIAL_RESIDUAL_COLUMNS,
} from "./mirror-credentials";
import { MIRROR_TABLES } from "./export-core";

describe("what the mirror may never carry (#2564)", () => {
  it("names the booking manage token and the manage URL inside the webhook payload", () => {
    // Both routes or neither. Blanking bookings.manage_token alone leaves the same
    // credential in the warehouse inside webhook_deliveries.payload.manage_url, and
    // measured on production 2026-09-18 that second route held MORE rows than the
    // first (6,522 of 6,550 deliveries against 2,392 bookings).
    const named = MIRROR_CREDENTIALS.map((c) => `${c.table}.${c.column}${c.jsonKey ? `:${c.jsonKey}` : ""}`);
    expect(named).toContain("bookings.manage_token");
    expect(named).toContain("webhook_deliveries.payload:manage_url");
  });

  it("names only columns the mirror actually exports, so an entry cannot be about nothing", () => {
    for (const c of MIRROR_CREDENTIALS) {
      const spec = MIRROR_TABLES.find((t) => t.table === c.table);
      expect(spec, `${c.table} is a mirrored table`).toBeDefined();
      expect(
        spec?.cols.some((col) => col.name === c.column),
        `${c.table}.${c.column} is an exported column`,
      ).toBe(true);
    }
  });

  it("gives every entry a reason saying what holding the value lets somebody DO", () => {
    for (const c of MIRROR_CREDENTIALS) {
      expect(c.why.length, `${c.table}.${c.column} carries a reason`).toBeGreaterThan(20);
    }
  });
});

describe("redactMirrorCredentials", () => {
  it("nulls a credential column without touching the rest of the row", () => {
    const rows = [{ id: "bk1", manage_token: "tok-secret", attendee_email: "a@b.c", updated_at: "2026-09-18T00:00:00Z" }];

    const out = redactMirrorCredentials("bookings", rows);

    expect(out[0].manage_token).toBeNull();
    expect(out[0].attendee_email).toBe("a@b.c");
    // The keyset cursor is read off the row AFTER the merge, so id and the
    // watermark must survive redaction or the export loops on one page forever.
    expect(out[0].id).toBe("bk1");
    expect(out[0].updated_at).toBe("2026-09-18T00:00:00Z");
  });

  it("does not mutate the caller's rows", () => {
    const rows = [{ id: "bk1", manage_token: "tok-secret" }];

    redactMirrorCredentials("bookings", rows);

    expect(rows[0].manage_token).toBe("tok-secret");
  });

  it("removes the credential KEY from a JSON payload and keeps every other key", () => {
    const rows = [
      {
        id: "d1",
        payload: { booking_id: "bk1", manage_url: "https://slate.example/booking/manage/tok-secret", attendee: { email: "a@b.c" } },
      },
    ];

    const out = redactMirrorCredentials("webhook_deliveries", rows);

    const payload = out[0].payload as Record<string, unknown>;
    expect("manage_url" in payload).toBe(false);
    expect(payload.booking_id).toBe("bk1");
    expect(payload.attendee).toEqual({ email: "a@b.c" });
  });

  it("leaves a payload that is not an object alone rather than throwing", () => {
    // A null payload is legitimate, and a redaction that threw would abort the
    // whole export batch over a row it had nothing to do.
    const rows = [{ id: "d1", payload: null }, { id: "d2", payload: "not-an-object" }];

    const out = redactMirrorCredentials("webhook_deliveries", rows);

    expect(out[0].payload).toBeNull();
    expect(out[1].payload).toBe("not-an-object");
  });

  it("returns rows for an unlisted table unchanged", () => {
    const rows = [{ id: "b1", code: "411" }];
    expect(redactMirrorCredentials("buckets", rows)).toEqual(rows);
  });
});

describe("the warehouse cleanup SQL", () => {
  it("is derived from the same list, so a new entry cannot be exported but never cleaned", () => {
    const statements = buildCredentialBlankStatements();
    expect(statements).toHaveLength(MIRROR_CREDENTIALS.length);
    for (const c of MIRROR_CREDENTIALS) {
      expect(
        statements.some((s) => s.sql.includes(c.table) && s.sql.includes(c.jsonKey ?? c.column)),
        `${c.table}.${c.column} has a blanking statement`,
      ).toBe(true);
    }
  });

  it("blanks only rows that still hold a value, so a settled warehouse costs one predicate", () => {
    for (const s of buildCredentialBlankStatements()) {
      expect(s.sql.toLowerCase()).toContain("is not null");
    }
  });

  it("removes the JSON key rather than emptying the payload the erasure verify reads", () => {
    const json = buildCredentialBlankStatements().find((s) => s.label.includes("webhook_deliveries"));
    // object_insert(..., null, true) removes the key: Snowflake omits a pair whose
    // value is SQL NULL, and TRUE is required because the key is already present.
    // Emptying the payload instead would destroy payload:booking_id, the only key
    // the erasure verify and the audit lane can find these rows by (#1201).
    expect(json?.sql).toContain("object_insert(payload, 'manage_url', null, true)");
    expect(json?.sql).not.toContain("object_construct()");
  });

  it("counts a residual per credential, each reading its OWN field", () => {
    const sql = buildCredentialResidualStatement();
    expect(CREDENTIAL_RESIDUAL_COLUMNS).toHaveLength(MIRROR_CREDENTIALS.length);
    for (const col of CREDENTIAL_RESIDUAL_COLUMNS) expect(sql).toContain(col);
    expect(sql).toContain("manage_token is not null");
    expect(sql).toContain("payload:manage_url is not null");
  });
});
