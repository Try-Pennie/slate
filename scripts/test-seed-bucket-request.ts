// The seeder's REFRESH is an update, and it could never have been an upsert.
//
// `scripts/seed-buckets.ts` sent its sixty refresh rows as one POST with
// `Prefer: resolution=merge-duplicates`, carrying only `org_id`, `code`, `name`
// and `criteria`. PostgREST builds that as an INSERT with an ON CONFLICT clause,
// so every column absent from the row is NULL on the tentative insert, and
// `buckets.event_type_id` is NOT NULL. Run against production on 2026-09-10 it
// answered 400 `23502` on the very first row and wrote nothing at all.
//
// It has been in that state since #1935 stopped the seeder writing
// `event_type_id`, which is the change that made a refresh row partial. Nothing
// noticed, because the seeder is a hand run command and the failure is loud only
// to whoever runs it: the documented way to push a criteria change to all sixty
// buckets simply threw.
//
// A refresh of an existing row is an UPDATE by definition, and an update carries
// no obligation to the columns it does not name, so this is the shape that
// cannot come back.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-seed-bucket-request.ts
import { refreshBuckets, refreshRequest } from "./lib/seed-bucket-request.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const row = {
  org_id: "9d907038-8156-4ccf-aeee-d3baeb8e2765",
  code: "411",
  name: "Very High | Both | Legal",
  criteria: { debt_team: "very_high" },
};

const req = refreshRequest(row);

// --- it is an update, and PostgREST is told so by the verb ---
eq(req.method, "PATCH", "a refresh is an update");

// --- the row is addressed by a FILTER, so nothing is ever inserted ---
assert(
  req.path.includes(`org_id=eq.${row.org_id}`) && req.path.includes("code=eq.411"),
  `the row is found by org and code (${req.path})`,
);

// --- and the identity is NOT in the body, which is what makes an insert
//     impossible even if the verb were ever changed back ---
eq(Object.keys(req.body).sort().join(","), "criteria,name", "only the two fields the seeder owns");
for (const key of ["org_id", "code", "event_type_id", "assignment", "fallback_user_id"]) {
  assert(!(key in req.body), `the body carries no ${key}`);
}
eq(req.body.name, row.name, "the name is what the spec says");
eq(JSON.stringify(req.body.criteria), JSON.stringify(row.criteria), "and so are the criteria");

// --- a code is encoded rather than pasted into the query string ---
{
  const smoke = refreshRequest({ ...row, code: "SMOKE 2" });
  assert(
    !smoke.path.includes("SMOKE 2"),
    `a code with a space is encoded (${smoke.path})`,
  );
  assert(smoke.path.includes("code=eq.SMOKE%202"), `and encoded correctly (${smoke.path})`);
}

// --- one request per row, since each row has different values: a single PATCH
//     with a filter would write one bucket's name over every other bucket ---
{
  const other = refreshRequest({ ...row, code: "412", name: "Very High | Both | Non-Legal" });
  assert(other.path !== req.path, "two codes address two different rows");
  assert(other.body.name !== req.body.name, "and carry their own name");
}

// ---------------------------------------------------------------------------
// The LOOP, which is where the two honesty claims live.
// ---------------------------------------------------------------------------
type Call = { url: string; method: string; body: string };

/** A fake PostgREST that answers each PATCH with the rows it claims to have changed. */
function fakeFetch(answer: (call: Call) => { ok: boolean; status: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { method: string; body: string }) => {
    const call = { url, method: init.method, body: init.body };
    calls.push(call);
    const a = answer(call);
    return { ok: a.ok, status: a.status, json: async () => a.body };
  };
  return { calls, impl: impl as unknown as typeof fetch };
}

const rows = [row, { ...row, code: "412", name: "Very High | Both | Non-Legal" }];
const opts = { base: "https://db.example/rest/v1", headers: { apikey: "k" } };

// --- one request per row, each addressing its own bucket ---
{
  const f = fakeFetch((c) => ({ ok: true, status: 200, body: [{ code: c.url.slice(-3) }] }));
  const changed = await refreshBuckets(rows, { ...opts, fetchImpl: f.impl });
  eq(changed, 2, "two rows changed two buckets");
  eq(f.calls.length, 2, "one request per row");
  eq(f.calls[0].method, "PATCH", "sent as an update");
  assert(f.calls[0].url.startsWith(opts.base), `the base is used (${f.calls[0].url})`);
  assert(f.calls[0].url !== f.calls[1].url, "each row addresses its own bucket");
}

// --- a row the filter matched NOTHING must throw, never count ---
//
// PostgREST answers a PATCH that matched no row with 200 and an empty array. A
// loop counting rows SENT would report sixty successful refreshes over a filter
// that touched nothing, which is the exact shape of a check that cannot fail
// (L98). So the count comes from what the database said it changed.
{
  const f = fakeFetch((c) =>
    c.url.includes("412") ? { ok: true, status: 200, body: [] } : { ok: true, status: 200, body: [{ code: "411" }] },
  );
  let threw: string | null = null;
  try {
    await refreshBuckets(rows, { ...opts, fetchImpl: f.impl });
  } catch (err) {
    threw = String(err);
  }
  assert(threw !== null, "a filter that matched nothing is a failure, not a silent zero");
  assert(threw!.includes("412"), `and it names the code (${threw})`);
}

// --- a refusal throws, naming the code and the status ---
{
  const f = fakeFetch(() => ({ ok: false, status: 400, body: { code: "23502" } }));
  let threw: string | null = null;
  try {
    await refreshBuckets(rows, { ...opts, fetchImpl: f.impl });
  } catch (err) {
    threw = String(err);
  }
  assert(threw !== null, "a refused request throws");
  assert(threw!.includes("400") && threw!.includes("411"), `naming status and code (${threw})`);
  eq(f.calls.length, 1, "and stops rather than sending the rest at a database that is refusing");
}

// --- nothing to do is nothing sent ---
{
  const f = fakeFetch(() => ({ ok: true, status: 200, body: [{ code: "x" }] }));
  eq(await refreshBuckets([], { ...opts, fetchImpl: f.impl }), 0, "an empty list changes nothing");
  eq(f.calls.length, 0, "and sends nothing");
}

finish();
