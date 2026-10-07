// The REAL burst driver, run against a local stub deployment (#3325).
//
// The pure parts of the burst (the plan reader, the split, the file names) are pinned
// in test-loadtest-book-plan.ts. What only running the driver can show is that the
// shell wires them together: it fires every burst in the plan, one file per burst,
// splits each burst across both codes, and records on every attempt, burst and
// steady alike, what the deployment echoed, through the one parser the deployment's
// builders are tested against. The stub writes its headers through those SAME
// builders, so it cannot speak a dialect the real deployment does not (L52 is why it
// is the contract's builders and not hand typed header names).
//
// One answer per burst carries a line value the contract does not know, and one
// carries no echo at all: the first must be recorded as UNREADABLE with what was
// sent and the second as ABSENT, never dropped and never read as a value.
//
// The moments are a couple of seconds ahead with a generous grace, so a slow machine
// starting node late still fires every burst rather than failing on load (L290).
//
// Run: node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-loadtest-burst-driver.ts
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { burstCodeFor, burstLegOut, REQUEST_TIMEOUT_MS, type BurstPlan, type DriverResult } from "./loadtest/book-plan.ts";
import {
  answeredAtEchoHeader,
  confirmLineEchoHeaders,
  CONFIRM_LINE_HEADER,
} from "../src/lib/loadtest-echo.ts";
import { assert, eq, finish } from "./lib/harness.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const REQUESTS = 4;
const DRIVER = 2;
const CODES: [string, string] = ["120", "121"];
const SLOTS = ["2026-10-06T14:00:00.000Z", "2026-10-06T15:10:00.000Z", "2026-10-06T16:20:00.000Z"];

/** The request number a booking body's external id carries (`<run>-b-<driver>-<n>`). */
function requestNumber(externalId: string): number {
  return Number(externalId.split("-").pop());
}

/** What the stub saw, so a test can say what the driver asked and when. */
interface Seen {
  codes: string[];
  bodies: number;
  /** #3429: each bookable probe, with when it arrived. */
  probes: { code: string; startIso: string; atMs: number }[];
  /** #3429: how many times the driver asked the deployment for its crowd rule. */
  versions: number;
}

async function withStub<T>(
  run: (base: string, seen: Seen) => Promise<T>,
  opts: { rule?: string | null } = {},
): Promise<T> {
  const seen: Seen = { codes: [], bodies: 0, probes: [], versions: 0 };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/availability")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ slots: SLOTS }));
      return;
    }
    // #3429: the version answer a load test deployment sends, carrying its crowd rule
    // (or not, the way a deployment before #3429 answers).
    if (req.url === "/api/smoke/version" && req.method === "GET") {
      seen.versions += 1;
      const rule = opts.rule === undefined ? "walks" : opts.rule;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ commit: "abc1234", loadtest: true, faultPct: 0, ...(rule === null ? {} : { confirmCrowdRule: rule }) }));
      return;
    }
    // #3429: the bookable probe, answered in the route's own shape.
    if (req.url?.startsWith("/api/bookings/bookable") && req.method === "GET") {
      const q = new URL(req.url, "http://stub").searchParams;
      seen.probes.push({ code: q.get("bucketCode") ?? "", startIso: q.get("startIso") ?? "", atMs: Date.now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          bookable: true,
          reason: "available",
          requestedBucketCode: q.get("bucketCode"),
          effectiveBucketCode: "130",
          tierFallback: true,
          rungsDropped: 1,
          wouldAssign: { id: "agent-x", name: null, email: null },
        }),
      );
      return;
    }
    if (req.url === "/api/bookings" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as { bucketCode: string; externalId: string };
        seen.codes.push(body.bucketCode);
        seen.bodies += 1;
        const n = requestNumber(body.externalId);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (n === 1) {
          // A line value the contract does not know.
          headers[CONFIRM_LINE_HEADER] = "Shared";
        } else if (n !== 2) {
          // n === 2 sends no echo at all, the way a deployment without the line does.
          for (const [k, v] of confirmLineEchoHeaders({ line: "shared", reason: "ok", key: "ladder", lineMs: 12 })) {
            headers[k] = v;
          }
          const [k, v] = answeredAtEchoHeader(Date.now());
          headers[k] = v;
        }
        const won = n % REQUESTS === 0;
        res.writeHead(won ? 200 : 409, headers);
        // #3429: a 200 says which rung took it, the way the booking API's body does.
        res.end(
          JSON.stringify(
            won ? { outcome: "booked", bucket: { code: "130", requestedCode: body.bucketCode, tierFallback: true, rungsDropped: 1 } } : { code: "SLOT_TAKEN" },
          ),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function runDriver(
  base: string,
  env: Record<string, string>,
  // A module preloaded into the driver only, such as the early timers below.
  preload: string[] = [],
): Promise<{ code: number; stderr: string }> {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        "./scripts/register-paths.mjs",
        ...preload.flatMap((m) => ["--import", m]),
        "scripts/loadtest/book.ts",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          SLATE_BASE: base,
          BOOKING_API_KEY: "test-key",
          RUN_ID: "run-3325",
          DRIVER: String(DRIVER),
          ...env,
        },
        timeout: 60_000,
      },
    );
    return { code: 0, stderr: "" };
  } catch (err) {
    return { code: (err as { code?: number }).code ?? 1, stderr: String((err as { stderr?: string }).stderr ?? "") };
  }
}

/** #3429: a burst of the plan, each with its own kind, codes and share. */
function burstOf(slot: string, startAtMs: number, kind: "refusal" | "drop" = "refusal", perDriver = REQUESTS) {
  return { kind, codes: CODES, slot, startAtMs, perDriver, capacity: { ladderRoster: 16, rung0Free: 1, ladderFree: 9 } };
}

function plan(startAts: number[]): BurstPlan {
  return { bursts: startAts.map((startAtMs, i) => burstOf(SLOTS[i]!, startAtMs)) };
}

/** The settle seam this test drives with: a short settle so the probe comes in under a second. */
const SETTLE_MS = 600;

const readFile = (path: string) => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DriverResult) : null);

// --- three bursts, three files, both codes, every echo recorded --------------------
{
  const dir = mkdtempSync(join(tmpdir(), "slate-3325-"));
  const out = join(dir, `burst-${DRIVER}.json`);
  const startedAt = Date.now();
  const t = startedAt + 2_000;
  // #3429: the middle burst is a drop burst of two requests a driver, so each burst's
  // own share and kind are seen to reach the file.
  const threeLegs: BurstPlan = { bursts: [burstOf(SLOTS[0]!, t), burstOf(SLOTS[1]!, t + 300, "drop", 2), burstOf(SLOTS[2]!, t + 600)] };
  const { code, stderr, seen } = await withStub(async (base, seen) => ({
    ...(await runDriver(base, {
      MODE: "burst",
      OUT: out,
      BURST_GRACE_MS: "30000",
      BURST_SETTLE_MS: String(SETTLE_MS),
      BURST_PLAN: JSON.stringify(threeLegs),
    })),
    seen,
  }));
  const finishedAt = Date.now();
  eq(code, 0, `a driver that made every burst exits zero ${stderr.slice(0, 300)}`);
  eq(seen.bodies, 2 * REQUESTS + 2, "it fired every request of every burst, each burst its own share");

  const files = [0, 1, 2].map((i) => readFile(burstLegOut(out, i)));
  assert(files.every((f) => f !== null), "one file per burst, beside the driver's own name");
  for (const [i, f] of files.entries()) {
    const share = i === 1 ? 2 : REQUESTS;
    eq(f?.mode, "burst", `burst ${i + 1}'s file is a burst file`);
    eq(f?.burstLeg?.index, i, `and says which burst it holds`);
    eq(f?.burstLeg?.of, 3, "out of how many");
    eq(f?.burstLeg?.slot, SLOTS[i], "at the slot the plan named");
    eq(f?.burstLeg?.codes, CODES, "split across the plan's two codes");
    eq(f?.burstLeg?.kind, i === 1 ? "drop" : "refusal", "of the kind the plan named (#3429)");
    eq(f?.burstLeg?.capacity, { ladderRoster: 16, rung0Free: 1, ladderFree: 9 }, "carrying what the setup measured");
    // #3459 review: the grace and request bound it ran with, so the judge settles the
    // burst on what its drivers were configured with rather than on the defaults.
    eq(f?.burstLeg?.graceMs, 30_000, "recording the grace it was configured with");
    eq(f?.burstLeg?.requestBoundMs, REQUEST_TIMEOUT_MS, "and the abort bound its requests carried");
    eq(f?.planned, share, "planning its own share");
    eq(f?.attempts.length, share, "holding its whole burst");
    eq(
      f?.attempts.map((a) => a.code),
      Array.from({ length: share }, (_, n) => burstCodeFor(CODES, DRIVER, n)),
      "each request asking for the code the split gives it",
    );
    assert(f?.attempts.every((a) => a.startIso === SLOTS[i]) === true, "every request at that burst's slot");
    // #3429: the deployment's crowd rule, read once and recorded on every burst.
    eq(f?.crowdRule, { state: "read", value: "walks" }, "the crowd rule the deployment declared");
    // #3429: the slot probed once the burst settled, through the driver's own reader.
    const probe = f?.probe;
    assert(
      probe?.kind === "read" && probe.bookable && probe.rungsDropped === 1 && probe.effectiveCode === "130",
      `the slot's probe is recorded as the deployment answered it (got ${JSON.stringify(probe)})`,
    );
    eq(probe?.code, burstCodeFor(CODES, DRIVER, 0), "asked of the code this driver opened on");
    const moment = threeLegs.bursts[i]!.startAtMs;
    assert(probe !== undefined && probe.sentAtMs >= moment + SETTLE_MS, `and sent only once the burst settled (${probe ? probe.sentAtMs - moment : "none"}ms after its moment)`);
    // A 200 records which rung took it; a refusal records nothing.
    const won = f?.attempts.find((a) => a.status === 200);
    eq(won?.rungsDropped, 1, "a winner records the rung its answer named");
    assert(f?.attempts.filter((a) => a.status !== 200).every((a) => a.rungsDropped === undefined) === true, "and a refusal names no rung");
  }
  eq(seen.versions, 1, "the crowd rule is asked once, before the first burst");
  eq(seen.probes.length, 3, "and the slot is probed once per burst");
  eq(seen.probes.map((p) => p.startIso), SLOTS, "each at its own burst's slot");
  const ids = files.flatMap((f) => f?.attempts.map((a) => a.externalId) ?? []);
  eq(new Set(ids).size, 2 * REQUESTS + 2, "no two of the run's burst requests share an external id");
  eq(new Set(seen.codes).size, 2, "and the deployment was asked for both codes");

  const normal = files[1]!.attempts[0]!.echo!;
  eq(normal.line, { state: "read", value: "shared" }, "the line is recorded as read");
  eq(normal.reason, { state: "read", value: "ok" }, "with its reason");
  eq(normal.key, { state: "read", value: "ladder" }, "its key kind");
  eq(normal.lineMs, { state: "read", value: 12 }, "and the time the line added");
  assert(
    normal.answeredAtMs.state === "read" &&
      normal.answeredAtMs.value >= startedAt &&
      normal.answeredAtMs.value <= finishedAt,
    `and the deployment's answer stamp (got: ${JSON.stringify(normal.answeredAtMs)})`,
  );

  const garbled = files[0]!.attempts[1]!.echo!;
  eq(garbled.line, { state: "unreadable", raw: "Shared" }, "a value the contract does not know is UNREADABLE, kept with what was sent");
  eq(garbled.answeredAtMs, { state: "absent" }, "and a stamp it never sent is absent");

  const silent = files[0]!.attempts[2]!.echo!;
  eq(silent.line, { state: "absent" }, "an answer with no echo at all records every field as absent");
  eq(silent.lineMs, { state: "absent" }, "never a zero");
  rmSync(dir, { recursive: true, force: true });
}

// --- #3429: a timer that returns early never sends the probe before the settle ------
//
// Run 37568349592 sent a probe 599ms after its moment against a 600ms settle: one
// sleep toward the settle, and the timer returned a millisecond before the wall clock
// reached it. The judge reads a probe sent before the burst settled as one it cannot
// use, so a single early timer leaves the run INCOMPLETE. The driver's timers fire at
// half their delay here, so one sleep is early on every run, never only an unlucky one.
{
  const dir = mkdtempSync(join(tmpdir(), "slate-3429-"));
  const out = join(dir, `burst-${DRIVER}.json`);
  const t = Date.now() + 2_000;
  const { code, stderr } = await withStub(async (base) =>
    runDriver(
      base,
      {
        MODE: "burst",
        OUT: out,
        BURST_GRACE_MS: "30000",
        BURST_SETTLE_MS: String(SETTLE_MS),
        BURST_PLAN: JSON.stringify({ bursts: [burstOf(SLOTS[0]!, t)] }),
      },
      ["./scripts/lib/early-timers.mjs"],
    ),
  );
  eq(code, 0, `a driver whose timers fire early still makes its burst ${stderr.slice(0, 300)}`);
  const probe = readFile(burstLegOut(out, 0))?.probe;
  assert(
    probe !== undefined && probe.sentAtMs >= t + SETTLE_MS,
    `and sends its probe only once the wall clock reaches the settle (${probe ? probe.sentAtMs - t : "none"}ms after its moment, settle ${SETTLE_MS}ms)`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- a lead outside the phone's digits stops the driver by name, before any send ----
//
// `book()` builds its body before its try, as the ceiling control does (#3447), so a
// lead `loadtestPhone` refuses ends the driver naming why rather than being recorded
// as a request that failed in transit. A driver number past 99 is the coordinate a
// valid plan can still reach (the plan reader refuses request numbers past 9999).
{
  const dir = mkdtempSync(join(tmpdir(), "slate-3429-"));
  const out = join(dir, `burst-${DRIVER}.json`);
  const t = Date.now() + 2_000;
  const { code, stderr, seen } = await withStub(async (base, seen) => ({
    ...(await runDriver(base, {
      MODE: "burst",
      OUT: out,
      DRIVER: "100",
      BURST_GRACE_MS: "30000",
      BURST_SETTLE_MS: String(SETTLE_MS),
      BURST_PLAN: JSON.stringify({ bursts: [burstOf(SLOTS[0]!, t)] }),
    })),
    seen,
  }));
  assert(code !== 0, `a driver whose leads have no number of their own does not exit zero (got ${code})`);
  assert(/driver 100 is outside 0 to 99/.test(stderr), `and says why, by name (got: ${stderr.slice(0, 300)})`);
  eq(seen.bodies, 0, "having sent no booking at all");
  rmSync(dir, { recursive: true, force: true });
}

// --- a burst a driver wakes too late for is written as missed, and the rest fire ----
{
  const dir = mkdtempSync(join(tmpdir(), "slate-3325-"));
  const out = join(dir, `burst-${DRIVER}.json`);
  const now = Date.now();
  const { code, seen } = await withStub(async (base, seen) => ({
    ...(await runDriver(base, {
      MODE: "burst",
      OUT: out,
      BURST_GRACE_MS: "30000",
      BURST_SETTLE_MS: String(SETTLE_MS),
      BURST_PLAN: JSON.stringify(plan([now - 120_000, now + 2_000, now + 2_300])),
    })),
    seen,
  }));
  eq(code, 3, "a driver that missed a burst exits 3, so the miss is visible in the workflow");
  const first = readFile(burstLegOut(out, 0));
  eq(first?.burstSkipped, "missed", "the missed burst's file says so");
  eq(first?.attempts.length, 0, "having fired nothing late");
  eq(first?.probe, undefined, "and probed nothing for a burst it never fired");
  eq(readFile(burstLegOut(out, 1))?.attempts.length, REQUESTS, "and the bursts after it still fired");
  eq(readFile(burstLegOut(out, 2))?.attempts.length, REQUESTS, "all of them");
  eq(seen.bodies, 2 * REQUESTS, "so the deployment saw exactly the bursts that were on time");
  eq(seen.probes.length, 2, "and only those were probed");
  rmSync(dir, { recursive: true, force: true });
}

// --- #3429: a deployment that does not say its crowd rule is recorded as not saying --
{
  const dir = mkdtempSync(join(tmpdir(), "slate-3429-"));
  const out = join(dir, `burst-${DRIVER}.json`);
  const t = Date.now() + 2_000;
  const { code } = await withStub(
    async (base) =>
      runDriver(base, {
        MODE: "burst",
        OUT: out,
        BURST_GRACE_MS: "30000",
        BURST_SETTLE_MS: String(SETTLE_MS),
        BURST_PLAN: JSON.stringify({ bursts: [burstOf(SLOTS[0]!, t)] }),
      }),
    { rule: null },
  );
  eq(code, 0, "a deployment that states no rule does not stop the burst");
  const f = readFile(burstLegOut(out, 0));
  eq(f?.crowdRule?.state, "absent", "its silence is recorded as absent, for the judge to refuse to guess");
  rmSync(dir, { recursive: true, force: true });
}

// --- the steady pass records the echo too ---------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "slate-3325-"));
  const out = join(dir, `driver-${DRIVER}.json`);
  const { code, stderr } = await withStub((base) =>
    runDriver(base, { MODE: "steady", OUT: out, DRIVE_DEADLINE_MS: "1500" }),
  );
  eq(code, 0, `a short steady pass exits zero ${stderr.slice(0, 300)}`);
  const steady = readFile(out);
  const first = steady?.attempts[0];
  assert(first !== undefined, "and made at least one booking");
  // The steady driver's first request is n 0, which the stub answers normally.
  eq(first?.echo?.line, { state: "read", value: "shared" }, "a steady attempt records which line served it");
  eq(first?.echo?.lineMs, { state: "read", value: 12 }, "and the time the line added, for the steady report");
  rmSync(dir, { recursive: true, force: true });
}

finish();
