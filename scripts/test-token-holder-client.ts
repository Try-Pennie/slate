// The app's side of the shared token holder (#3512): how a read is bounded and how every
// way the holder can fail is named, driven through a fake namespace and a fake timer.
//
// A read NEVER rejects. It answers a hit, a miss, or the reason the holder could not
// answer (timeout, error, expired, unbound), because the caller's response to all of the
// failures is the same (mint as it always has) while the log has to say which one it was.
// A failing holder must never fail a booking.
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-token-holder-client.ts
import {
  makeTokenHolderClient,
  TOKEN_HOLDER_READ_MS,
  type TokenHolderNamespace,
} from "../src/lib/google/token-holder.ts";
import {
  makeTokenHolderObject,
  TOKEN_HOLDER_INSTANCE,
  TOKEN_HOLDER_PROTOCOL,
  TOKEN_USABLE_MARGIN_MS,
} from "../src/lib/google/token-holder-object.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const HOUR = 3_600_000;
const now = 5_000_000;
const clock = () => now;

interface Pending {
  ms: number;
  fire: () => void;
  cleared: boolean;
}
let timers: Pending[] = [];
const timer = (ms: number, fire: () => void) => {
  const t: Pending = { ms, fire, cleared: false };
  timers.push(t);
  return () => {
    t.cleared = true;
  };
};
const fireAll = () => {
  for (const t of timers.splice(0)) if (!t.cleared) t.fire();
};

/** A namespace whose one object answers through `answer`, recording what it was asked. */
function namespace(answer: (body: Record<string, unknown>) => Promise<Response>) {
  const asked: { name: string; hint?: string; body: Record<string, unknown> }[] = [];
  const ns: TokenHolderNamespace = {
    idFromName: (name) => ({ name }),
    get: (id, opts) => ({
      async fetch(_url, init) {
        const body = JSON.parse(init.body ?? "null") as Record<string, unknown>;
        asked.push({ name: (id as { name: string }).name, hint: opts?.locationHint, body });
        return answer(body);
      },
    }),
  };
  return { ns, asked };
}

/** A namespace backed by the REAL holder object, so the protocol is tested end to end. */
function realHolder() {
  const object = makeTokenHolderObject({ now: clock, timer: () => () => {} });
  return namespace(async (body) => new Response(JSON.stringify(object.handle(body)), { status: 200 }));
}

const K = "calendar\nadvisor@trypennie.com";

// --- the deadline is justified, not borrowed ------------------------------------------
// Confirm path mints measured p50 170 to 270ms (#3680, #3512). The holder's read must
// cost less than the mint it replaces, so a slow holder followed by a mint costs at most
// this much over today.
assert(TOKEN_HOLDER_READ_MS < 170, `the holder read deadline (${TOKEN_HOLDER_READ_MS}ms) is under the fastest measured confirm path mint p50`);
assert(TOKEN_HOLDER_READ_MS >= 50, "and leaves room above a warm object call (about 40ms, #3555)");

// --- a round trip through the real object ------------------------------------------------
{
  const { ns, asked } = realHolder();
  const client = makeTokenHolderClient({ namespace: ns, timer, now: clock });
  eq(await client.read(K, TOKEN_HOLDER_READ_MS), { kind: "miss" }, "an empty holder reads as a miss");
  eq(await client.put(K, "tok-1", now + HOUR), "stored", "a put is stored");
  eq(await client.read(K, TOKEN_HOLDER_READ_MS), { kind: "hit", token: "tok-1", expMs: now + HOUR, refresh: false }, "and read back as a hit");
  assert(asked.every((a) => a.name === TOKEN_HOLDER_INSTANCE), "every call goes to the one shared instance");
  assert(asked.every((a) => a.hint === "wnam"), "created near the database, where the Worker runs");
  assert(asked.every((a) => a.body.v === TOKEN_HOLDER_PROTOCOL), "every message carries the protocol version");
  eq(timers.filter((t) => !t.cleared).length, 0, "no deadline timer is left behind by an answered read");
  timers = [];
}

// --- the holder does not answer in time ---------------------------------------------------
{
  const { ns } = namespace(() => new Promise<Response>(() => {}));
  const client = makeTokenHolderClient({ namespace: ns, timer, now: clock });
  let settled: unknown = "pending";
  const reading = client.read(K, 120).then((r) => (settled = r));
  await Promise.resolve();
  eq(settled, "pending", "a hung holder is waited on");
  eq(timers[0]?.ms, 120, "for the wait the caller gave, and no longer");
  fireAll();
  await reading;
  eq(settled, { kind: "timeout", waitedMs: 120 }, "then answered as a timeout, never a rejection");
  timers = [];
}

// --- the holder throws, or answers something that is not the protocol ------------------
for (const [label, answer, reason] of [
  ["a binding that throws", () => Promise.reject(new Error("Durable Object reset because its code was updated.")), /code was updated/],
  ["a non JSON answer", () => Promise.resolve(new Response("<html>oops</html>", { status: 500 })), /not the holder's answer/],
  ["a JSON answer of the wrong shape", () => Promise.resolve(new Response(JSON.stringify({ kind: "hit", token: 7 }), { status: 200 })), /not the holder's answer/],
  ["a refusal of the message", () => Promise.resolve(new Response(JSON.stringify({ kind: "bad", reason: "no readable key" }), { status: 200 })), /refused the read: no readable key/],
] as const) {
  const { ns } = namespace(answer as () => Promise<Response>);
  const client = makeTokenHolderClient({ namespace: ns, timer, now: clock });
  const r = (await client.read(K, TOKEN_HOLDER_READ_MS)) as { kind: string; reason?: string };
  eq(r.kind, "error", `${label} reads as an error, never a rejection`);
  assert(reason.test(r.reason ?? ""), `${label}: the reason says what happened (got ${r.reason})`);
  timers = [];
}

// --- the holder hands back a token that is no longer usable -----------------------------
{
  const { ns } = namespace(async () => new Response(JSON.stringify({ kind: "hit", token: "stale", expMs: now + TOKEN_USABLE_MARGIN_MS, refresh: false }), { status: 200 }));
  const client = makeTokenHolderClient({ namespace: ns, timer, now: clock });
  eq(await client.read(K, TOKEN_HOLDER_READ_MS), { kind: "expired" }, "a token with no usable time left is refused here too, whatever the holder thought");
  timers = [];
}

// --- no binding ------------------------------------------------------------------------------
{
  const client = makeTokenHolderClient({ namespace: null, timer, now: clock });
  eq(await client.read(K, TOKEN_HOLDER_READ_MS), { kind: "unbound" }, "no binding reads as unbound");
  let threw = false;
  try {
    await client.put(K, "t", now + HOUR);
  } catch {
    threw = true;
  }
  assert(threw, "and a put with no binding rejects, so the caller's background job reports it");
  eq(timers.length, 0, "with no timer armed for a call never made");
}

// --- a put that fails rejects, so its background job is reported ---------------------------
{
  const { ns } = namespace(() => Promise.reject(new Error("network lost")));
  const client = makeTokenHolderClient({ namespace: ns, timer, now: clock });
  let reason = "";
  await client.put(K, "t", now + HOUR).catch((e: unknown) => (reason = String(e)));
  assert(/network lost/.test(reason), "a put the holder never took rejects with the cause");
  timers = [];
}

// --- a put's answer never carries the token into an error ----------------------------------
{
  const { ns } = namespace(async () => new Response("nope", { status: 500 }));
  const client = makeTokenHolderClient({ namespace: ns, timer, now: clock });
  let reason = "";
  await client.put(K, "secret-token-value", now + HOUR).catch((e: unknown) => (reason = String(e)));
  assert(reason.length > 0 && !reason.includes("secret-token-value"), "a refused put's error never names the token");
  timers = [];
}

finish();
