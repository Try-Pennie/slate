import { describe, it, expect } from "vitest";
import { bucketDepthByCode } from "./bucket-depth";
import type { Bucket, BucketMember, User } from "@/lib/db/types";

// #584 consolidation: the admin buckets editor's "N eligible agents" count now
// comes from the shared staffing-depth helper, matching the booker's pool. This
// pins the behavior the old ad-hoc inline calc got wrong: it counted `bookable`
// agents WITHOUT excluding deactivated (offboarded) ones, and used ALL member
// rows instead of active ones, so it over-reported depth.

let seq = 0;
function mkBucket(p: Partial<Bucket> & { code: string }): Bucket {
  seq += 1;
  return {
    id: `b${seq}`,
    org_id: "o1",
    name: p.code,
    event_type_id: "et1",
    assignment: "round_robin",
    criteria: {},
    routing_form_id: null,
    fallback_user_id: null,
    is_test: false,
    created_at: "2026-07-09T00:00:00Z",
    ...p,
  };
}

type UserRow = Pick<User, "id" | "name" | "email" | "attributes" | "bookable" | "deactivated_at">;
function mkUser(p: Partial<UserRow> & { id: string }): UserRow {
  return {
    name: null,
    email: `${p.id}@x.com`,
    attributes: {},
    bookable: true,
    deactivated_at: null,
    ...p,
  };
}
function mkMember(p: Partial<BucketMember> & { bucket_id: string; user_id: string }): BucketMember {
  return { id: `m-${p.user_id}`, weight: 1, active: true, created_at: "2026-07-09T00:00:00Z", ...p };
}

describe("bucketDepthByCode", () => {
  it("excludes deactivated agents the old inline count wrongly included", () => {
    const bucket = mkBucket({ code: "311", criteria: { debt_team: "high" } });
    const users = [
      mkUser({ id: "live", attributes: { debt_team: "high" } }),
      mkUser({ id: "offboarded", attributes: { debt_team: "high" }, deactivated_at: "2026-06-01T00:00:00Z" }),
    ];
    const depth = bucketDepthByCode([bucket], users, []);
    // Old calc: 2 (counted the offboarded agent). Correct: 1.
    expect(depth.get("311")).toBe(1);
  });

  it("excludes non-bookable agents", () => {
    const bucket = mkBucket({ code: "111", criteria: { debt_team: "low" } });
    const users = [
      mkUser({ id: "a", attributes: { debt_team: "low" } }),
      mkUser({ id: "b", attributes: { debt_team: "low" }, bookable: false }),
    ];
    expect(bucketDepthByCode([bucket], users, []).get("111")).toBe(1);
  });

  it("counts only active manual members", () => {
    const bucket = mkBucket({ code: "121", criteria: {} });
    const users = [mkUser({ id: "u1" }), mkUser({ id: "u2" })];
    const members = [
      mkMember({ bucket_id: bucket.id, user_id: "u1", active: true }),
      mkMember({ bucket_id: bucket.id, user_id: "u2", active: false }),
    ];
    expect(bucketDepthByCode([bucket], users, members).get("121")).toBe(1);
  });

  it("returns a depth for every non-test bucket, keyed by code", () => {
    const buckets = [
      mkBucket({ code: "100", criteria: { debt_team: "low" } }),
      mkBucket({ code: "200", criteria: { debt_team: "med" } }),
    ];
    const users = [
      mkUser({ id: "a", attributes: { debt_team: "low" } }),
      mkUser({ id: "b", attributes: { debt_team: "low" } }),
      mkUser({ id: "c", attributes: { debt_team: "med" } }),
    ];
    const depth = bucketDepthByCode(buckets, users, []);
    expect(depth.get("100")).toBe(2);
    expect(depth.get("200")).toBe(1);
  });
});
