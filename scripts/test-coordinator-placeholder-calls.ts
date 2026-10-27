// How many calls sit on the placeholder at a time, for the coordinator page (#4205).
// Run: node --experimental-strip-types scripts/test-coordinator-placeholder-calls.ts
import { placeholderCallsAt, type PlaceholderCallsDeps } from "../src/lib/coordinator/placeholder-calls.ts";
import type { Bucket, EventType, User } from "../src/lib/db/types.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const real = { id: "b1", org_id: "org1", code: "412", is_test: false } as unknown as Bucket;
const test = { ...real, id: "b2", code: "T412", is_test: true } as Bucket;
const eventType = { duration_min: 30 } as unknown as EventType;

function deps(f: { noBucket?: boolean; noPlaceholder?: boolean; countThrows?: boolean } = {}) {
  const asked: unknown[] = [];
  const d: PlaceholderCallsDeps = {
    resolveBucketByCode: async (code) => (f.noBucket ? null : { bucket: code === "T412" ? test : real, eventType }),
    findPlaceholder: async (orgId, isTest) => {
      asked.push({ orgId, isTest });
      return f.noPlaceholder ? null : ({ id: isTest ? "marcia-test" : "marcia" } as User);
    },
    countOverlapping: async (userId, startIso, endIso) => {
      asked.push({ userId, startIso, endIso });
      if (f.countThrows) throw new Error("statement timeout");
      return 3;
    },
  };
  return { d, asked };
}

async function run() {
  {
    const { d, asked } = deps();
    const out = await placeholderCallsAt({ bucketCode: "412", startIso: "2026-06-09T15:00:00-04:00" }, d);
    eq(out, { ok: true, count: 3, startsAt: "2026-06-09T19:00:00.000Z", endsAt: "2026-06-09T19:30:00.000Z" }, "the calls overlapping the call's own half hour");
    eq(asked, [{ orgId: "org1", isTest: false }, { userId: "marcia", startIso: "2026-06-09T19:00:00.000Z", endIso: "2026-06-09T19:30:00.000Z" }], "on the real placeholder of the bucket's org");
  }
  {
    const { d, asked } = deps();
    await placeholderCallsAt({ bucketCode: "T412", startIso: "2026-06-09T19:00:00.000Z" }, d);
    eq((asked[1] as { userId: string }).userId, "marcia-test", "a test bucket counts the TEST placeholder");
  }
  eq(await placeholderCallsAt({ bucketCode: "412", startIso: "tomorrow" }, deps().d), { ok: false, reason: "start-unreadable" }, "an unreadable time is refused");
  eq(await placeholderCallsAt({ bucketCode: "999", startIso: "2026-06-09T19:00:00.000Z" }, deps({ noBucket: true }).d), { ok: false, reason: "no-bucket" }, "an unknown bucket is refused");
  eq(await placeholderCallsAt({ bucketCode: "412", startIso: "2026-06-09T19:00:00.000Z" }, deps({ noPlaceholder: true }).d), { ok: false, reason: "no-placeholder" }, "no placeholder is refused");
  let threw = false;
  try {
    await placeholderCallsAt({ bucketCode: "412", startIso: "2026-06-09T19:00:00.000Z" }, deps({ countThrows: true }).d);
  } catch {
    threw = true;
  }
  assert(threw, "a failed count throws, never answers zero");
}

run().then(finish, (err) => {
  console.error(err);
  process.exit(1);
});
