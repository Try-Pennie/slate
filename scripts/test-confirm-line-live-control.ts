// The shared confirm line LIVE positive control (#3340), driven offline. Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs \
//     scripts/test-confirm-line-live-control.ts
//
// Why this exists. The confirm path falls back to the isolate's own line whenever the
// shared one cannot be used (#3325), so an object that is bound and does not answer
// reads as healthy until a crowd arrives and stampedes the database again, exactly as
// in load run 37333201026. Nothing between load runs asked the object anything (L557).
// `pnpm verify:confirm-line` does, through `POST /api/smoke/confirm-line`, which drives
// the PRODUCTION client (`makeSharedConfirmLine`) against the real object.
//
// This file drives that probe against the REAL object host (`makeConfirmLineHost`) on a
// virtual clock, and then against a planted defect for every outcome the probe can
// name, so no outcome in its contract is one nothing has ever produced (L151). The live
// run then has only one question left that a fixture cannot answer: does the deployed
// object behave like this one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIRM_LINE_VERIFY_GROUP,
  CONFIRM_LINE_PROBE_REASON,
  CONFIRM_LINE_CHECKS,
  CHECK_OUTCOMES,
  CHECK_CAN_END_ON,
  PROBE_FOLLOWER_WAIT_MS,
  ABANDONED_LEAD_FREED_WITHIN_MS,
  VERDICT_REACHES_FOLLOWER_WITHIN_MS,
  PROBE_SWITCH,
  PLATFORM_HIBERNATE_AFTER_MS,
  PROBE_WAKE_IDLE_MS,
  PROBE_WAKE_READS,
  PROBE_LATE_ANSWER_MS,
  PROBE_DIRECTORY_FIRST_CALL_MS,
  runConfirmLineProbe,
  judgeHandOn,
  type ConfirmLineCheck,
  type CheckOutcome,
  type ProbeReport,
} from "../src/lib/monitor/confirm-line-probe.ts";
import {
  CONFIRM_LINE_EXIT,
  REPLY_DEADLINE_MS,
  readConfirmLineOutcome,
  judgeConfirmLineProbe,
  type ProbeOutcome,
} from "./lib/confirm-line-live-control.ts";
import {
  makeConfirmLineHost,
  makeConfirmLineObject,
  CONFIRM_LINE_ACK_MS,
  CONFIRM_LINE_LEASE_MS,
  CONFIRM_LINE_HEARTBEAT_MS,
  CONFIRM_LINE_PROTOCOL,
} from "../src/lib/booking/confirm-line-object.ts";
import { keyKindOf, CONFIRM_LINE_CALL_MS, type LineNamespace } from "../src/lib/booking/shared-confirm-line.ts";
import { ladderGroupOf } from "../src/lib/booking/line-key.ts";
import {
  POOL_GROUPING_DIRECTORY,
  POOL_GROUPING_VERIFY_DIRECTORY,
  groupingPutMessage,
  groupingSnapshotOf,
  type DirectoryStub,
} from "../src/lib/booking/pool-grouping.ts";
import { POOL_GROUPING_FETCH_GIVE_UP_MS } from "../src/lib/booking/pool-grouping-reader.ts";
import { confirmQueueKey } from "../src/lib/booking/orchestration.ts";
import { assert, eq, finish } from "./lib/harness.ts";
import { memoryGroupingStorage } from "./lib/memory-grouping-storage.ts";
import { hibernatingObjects, type HibernatingObjects } from "./lib/hibernating-objects.ts";
import type { GroupingDirectoryStorage } from "../src/lib/booking/pool-grouping.ts";

const ROOT = join(import.meta.dirname, "..");
type Message = Record<string, unknown>;
type Send = (message: Message) => Promise<Message>;
const tick = () => new Promise((r) => setImmediate(r));
/** Printable ASCII only, so no dash or emoji can reach a message (written as a range, not a literal). */
const PLAIN = /^[\x20-\x7E\n]*$/;
/** #3481: whether a call is the wake check's own put, which only it makes: its grouping's code names the wake. */
const isWakePut = (name: string, m: Message) =>
  name === POOL_GROUPING_VERIFY_DIRECTORY && m.op === "grouping-put" && JSON.stringify(m.snapshot).includes(":wake");

/** A virtual clock, the real object host, and a transport that can be swapped for a defect. */
function world() {
  let now = 1_791_000_000_000;
  const pending: { at: number; fire: () => void; live: boolean }[] = [];
  const timer = (ms: number, fire: () => void) => {
    const t = { at: now + ms, fire, live: true };
    pending.push(t);
    return () => {
      t.live = false;
    };
  };
  let ids = 0;
  const newId = () => `id${++ids}`;
  const newHost = () => makeConfirmLineHost({ now: () => now, timer, leaseTimer: timer, newId });
  const host = newHost();
  const handle = async (h: ReturnType<typeof newHost>, m: Message) => JSON.parse(await h.handle(m)) as Message;
  const groups: string[] = [];
  const instants = new Set<string>();
  let send: Send = (m) => handle(host, m);
  const namespace: LineNamespace = {
    stubFor(group) {
      groups.push(group);
      return {
        send(message) {
          if (message.op === "enter" && typeof message.line === "string") instants.add(message.line);
          return send(message);
        },
      };
    },
  };
  // #3460: the pool grouping directories, each the REAL object served as the directory,
  // through JSON both ways. The live one is seeded as the recompute lane would leave it,
  // so a healthy world passes and each defect below is the only thing wrong.
  //
  // #3481: and each sleeps as the platform's do. An instance left idle for the hibernation
  // window is discarded and the next call reaches a new one over the same storage, so the
  // healthy world is one in which the probe CAN see a wake, and a defect below can take
  // that away (a platform that never sleeps, or one that loses storage on the way).
  let platform: { idleMs: number; storageOnWake?: (kept: GroupingDirectoryStorage) => GroupingDirectoryStorage } = { idleMs: PLATFORM_HIBERNATE_AFTER_MS };
  let objects: HibernatingObjects<ReturnType<typeof makeConfirmLineObject>> | null = null;
  const directoryObjects = () =>
    (objects ??= hibernatingObjects({
      now: () => now,
      build: (storage) => makeConfirmLineObject({ now: () => now, timer, leaseTimer: timer, newId, directoryStorage: storage }),
      get idleMs() {
        return platform.idleMs;
      },
      storageOnWake: platform.storageOnWake,
    }));
  const directoryCalls: { name: string; op: string; at: number; wakePut: boolean }[] = [];
  const handleDirectory = async (name: string, m: Message) =>
    directoryObjects().call(name, async (o) => JSON.parse(await o.handle("directory", JSON.parse(JSON.stringify(m)) as unknown)) as Message);
  let directorySend: (name: string, m: Message) => Promise<Message> = handleDirectory;
  let directoryFor: (name: string) => DirectoryStub = (name) => ({
    send(m) {
      directoryCalls.push({ name, op: String(m.op), at: now, wakePut: isWakePut(name, m) });
      return directorySend(name, m);
    },
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => timer(ms, () => resolve()));
  const seedLive = async (readAtMs: number, format?: number) =>
    handleDirectory(POOL_GROUPING_DIRECTORY, groupingPutMessage({ ...groupingSnapshotOf([["120", "pool-a"], ["121", "pool-a"]], readAtMs), ...(format ? { format } : {}) }));
  /** What the live directory holds when the probe runs: as the lane leaves it, unless a defect says otherwise. */
  let liveSeed: "fresh" | "none" | "stale" | "other-format" = "fresh";
  /** How long the last run took on the virtual clock, from the probe starting to it answering. */
  let lastRunMs = 0;
  /**
   * The same run split where the wake check starts (its first call, the read just before
   * its own put), so the slowest line checks and the slowest wake can be added up even
   * though no single planted defect makes both slow. A run whose wake check never reached
   * its put spent no time waiting, so all of it counts before.
   */
  let lastSplit = { beforeWakeMs: 0, wakeMs: 0 };
  const run = async (ns: LineNamespace = namespace): Promise<ProbeReport | "unsettled"> => {
    if (liveSeed === "fresh") await seedLive(now - 5_000);
    if (liveSeed === "stale") await seedLive(now - 10 * 60_000);
    if (liveSeed === "other-format") await seedLive(now - 5_000, 99);
    let out: ProbeReport | "unsettled" = "unsettled";
    let settled = false;
    const startedAt = now;
    const callsBefore = directoryCalls.length;
    void runConfirmLineProbe({ namespace: ns, directory: (name) => directoryFor(name), now: () => now, timer, sleep, newId }).then((r) => {
      out = r;
      settled = true;
      lastRunMs = now - startedAt;
      const calls = directoryCalls.slice(callsBefore);
      const wakePut = calls.findIndex((c) => c.wakePut);
      const wakeStart = wakePut < 1 ? undefined : calls[wakePut - 1]?.at;
      lastSplit = wakeStart === undefined ? { beforeWakeMs: lastRunMs, wakeMs: 0 } : { beforeWakeMs: wakeStart - startedAt, wakeMs: now - wakeStart };
    });
    // Past the command's own reply deadline, so a probe slower than the command waits for
    // is seen here as slow rather than as unsettled.
    for (let spent = 0; !settled && spent < 2 * REPLY_DEADLINE_MS; spent += 25) {
      const until = now + 25;
      for (;;) {
        await tick();
        const due = pending.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.live = false;
        due.fire();
      }
      now = until;
    }
    await tick();
    return out;
  };
  return {
    host,
    newHost,
    handle,
    timer,
    newId,
    now: () => now,
    groups,
    instants,
    namespace,
    run,
    setSend(next: Send) {
      send = next;
    },
    directoryCalls,
    handleDirectory,
    lastRunMs: () => lastRunMs,
    lastSplit: () => lastSplit,
    directoryWakes: (name: string) => directoryObjects().wakes(name),
    setDirectoryPlatform(next: typeof platform) {
      if (objects) throw new Error("set the directory platform before anything calls a directory");
      platform = next;
    },
    /** Change how long an idle directory stays in memory, even mid run. */
    setDirectoryIdleMs(ms: number) {
      platform = { ...platform, idleMs: ms };
    },
    seedLive,
    setLiveSeed(next: typeof liveSeed) {
      liveSeed = next;
    },
    setDirectorySend(next: (name: string, m: Message) => Promise<Message>) {
      directorySend = next;
    },
    setDirectoryFor(next: (name: string) => DirectoryStub) {
      directoryFor = next;
    },
  };
}

const outcomes = (r: ProbeReport | "unsettled") =>
  r === "unsettled" ? "unsettled" : CONFIRM_LINE_CHECKS.map((c) => `${c}=${r[c].outcome}`).join(" ");

// --- the group the probe writes into cannot be a real line's ------------------------
{
  // The probe WRITES to a real object: it takes leads, queues and verdicts. Landing on
  // a real line would put a phantom leader in front of real confirms, or hand a real
  // follower a "taken" it never earned. A real group is `link:`, `code:` or `ladder:`
  // followed by something, and the Durable Object is named from the whole group, so the
  // prefix is the entire separation. `keyKindOf` is the production reading of exactly
  // those three prefixes, so the verification group must read as none of them.
  eq(keyKindOf(CONFIRM_LINE_VERIFY_GROUP), "none", "the verification group is none of the real line kinds");
  assert(CONFIRM_LINE_VERIFY_GROUP.startsWith("monitor:"), "and it is in the monitor space, which nothing in the booking path writes");

  // #3460: the pool grouping directory is a reserved instance of the same class, and it
  // must be just as unreachable from a real line key, the probe's own directory too.
  for (const reserved of [POOL_GROUPING_DIRECTORY, POOL_GROUPING_VERIFY_DIRECTORY]) {
    eq(keyKindOf(reserved), "none", `${reserved} is none of the real line kinds`);
    assert(reserved.startsWith("directory:"), `and ${reserved} is in the directory space, which nothing in the booking path writes`);
  }

  // Walk the one constructor every real line key comes from (`confirmQueueKey`), with
  // inputs chosen to TRY to land on the verification group or the directory: each name
  // itself as a code and as an advisor id, a code that already starts with monitor: or
  // directory:, and the ladder grouping fed pool keys that spell them.
  const hostile = [
    CONFIRM_LINE_VERIFY_GROUP,
    "monitor:",
    "monitor:x",
    POOL_GROUPING_DIRECTORY,
    POOL_GROUPING_VERIFY_DIRECTORY,
    "directory:",
    "directory:x",
    "",
    "521",
    "510",
    "100",
  ];
  const peeks: ((code: string) => string | null | undefined)[] = [
    () => undefined,
    () => null,
    () => CONFIRM_LINE_VERIFY_GROUP,
    () => POOL_GROUPING_DIRECTORY,
    (code) => `pool:${code}`,
  ];
  let walked = 0;
  for (const code of hostile) {
    for (const link of [undefined, ...hostile]) {
      for (const peek of peeks) {
        for (const lineGroupOf of [undefined, (c: string) => ladderGroupOf(c, peek)]) {
          const key = confirmQueueKey(code, "2026-10-06T14:00:00.000Z", link, lineGroupOf);
          walked++;
          if (keyKindOf(key.group) === "none" || key.group === CONFIRM_LINE_VERIFY_GROUP || key.group.startsWith("directory:")) {
            assert(false, `confirmQueueKey(${JSON.stringify(code)}, ${JSON.stringify(link)}) built ${key.group}, which is not a real line kind`);
          }
        }
      }
    }
  }
  assert(walked > 1000, `every real line key the walk built is a link, code or ladder group (${walked} built)`);
  {
    // Control: the walk would have noticed. A constructor that passed the code through
    // bare would build the verification group from the first hostile input.
    const bare = (code: string) => ({ group: code, instant: "1" });
    assert(keyKindOf(bare(CONFIRM_LINE_VERIFY_GROUP).group) === "none", "control: a group built without a kind prefix is caught by the same reading");
  }

  // The walk covers `confirmQueueKey` and the ladder grouping. What wires them in
  // production is read off the source, comments stripped so a comment ABOUT the wiring
  // cannot answer for it (L103).
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const service = strip(readFileSync(join(ROOT, "src/lib/booking/service.ts"), "utf8"));
  assert(/lineGroupOf:\s*\(code\)\s*=>\s*lineGroupOfLive\(code,/.test(service), "the booking service groups lines with lineGroupOfLive");
  const live = strip(readFileSync(join(ROOT, "src/lib/booking/confirm-line-live.ts"), "utf8"));
  const start = live.indexOf("export function lineGroupOfLive");
  const body = live.slice(start, live.indexOf("\n}\n", start) + 3);
  // #3460 retired the `return group;` reading: the confirm may now WAIT, bounded, for a
  // grouping before its key (#3355 items 1 and 2), and the function also notes where
  // its grouping came from. What it answers is still only what the ladder read built.
  assert(
    /const read\s*=\s*ladderGroupRead\(code,/.test(body) && /return read\.group;/.test(body) && (body.match(/return /g) ?? []).length === 1,
    "and lineGroupOfLive answers only what ladderGroupRead built, or null, through its one return",
  );
  const orchestration = strip(readFileSync(join(ROOT, "src/lib/booking/orchestration.ts"), "utf8"));
  const built = [...orchestration.matchAll(/\{\s*group\s*,\s*instant\s*:/g)].length;
  eq(built, 1, "and confirmQueueKey is the one place the booking path builds a line key, so the walk above covers them all");
}

// --- the timing constants the checks rest on, and why each sits where it does -------
{
  assert(
    ABANDONED_LEAD_FREED_WITHIN_MS > CONFIRM_LINE_ACK_MS,
    "an abandoned lead is judged after its acknowledgement window, never inside it",
  );
  assert(
    ABANDONED_LEAD_FREED_WITHIN_MS < CONFIRM_LINE_LEASE_MS,
    "and well before its lease, so a lead freed only by the lease is told apart from one freed by the window",
  );
  assert(
    PROBE_FOLLOWER_WAIT_MS > CONFIRM_LINE_LEASE_MS + CONFIRM_LINE_CALL_MS,
    "the follower waits past the lease, so a lead freed late is seen as late rather than as never",
  );
  // The leader's client retries a report once, so a verdict whose first send was lost
  // still hands on by the verdict, within two calls of that first send. Anything later is
  // a lease, and the earliest a lease can end after the report leaves is the lease less
  // one heartbeat (the last renewal can be up to a heartbeat before the report).
  eq(VERDICT_REACHES_FOLLOWER_WITHIN_MS, 2 * CONFIRM_LINE_CALL_MS, "a verdict reaches the follower within the report's own two calls");
  assert(
    VERDICT_REACHES_FOLLOWER_WITHIN_MS < CONFIRM_LINE_LEASE_MS - CONFIRM_LINE_HEARTBEAT_MS,
    "which is before the earliest a lease can end after the report leaves, so a hand on by the lease is never read as one by the verdict",
  );
  // The probe never reads the stored switch: the switch decides real confirms, and a
  // probe that stood down whenever it was off would prove nothing while the line is off.
  eq(PROBE_SWITCH.on, true, "the probe uses the shared line whatever the stored switch says");
  // #3481: the wake half. Every read the probe makes resets the object's idle clock, so
  // each spell between reads must on its own be past the platform's window, with room for
  // the runtime's own timing, or the probe's polling keeps the object awake and it can
  // never see a wake.
  assert(
    PROBE_WAKE_IDLE_MS >= 2 * PLATFORM_HIBERNATE_AFTER_MS,
    `each idle spell (${PROBE_WAKE_IDLE_MS}ms) is at least twice the platform's ${PLATFORM_HIBERNATE_AFTER_MS}ms hibernation window`,
  );
  assert(PROBE_WAKE_READS >= 2, "and there is more than one spell, so one the runtime happened to stretch is not the whole verdict");
}

async function main() {
  // --- the real host: every check passes, and the probe touches only its own group ---
  {
    const w = world();
    const report = await w.run();
    assert(report !== "unsettled", "the probe finishes against the real host");
    if (report !== "unsettled") {
      for (const check of CONFIRM_LINE_CHECKS) {
        eq(report[check].outcome, "passed", `real host: ${check} passes (${report[check].detail})`);
        assert(PLAIN.test(report[check].detail) && report[check].detail.length > 20, `real host: ${check} says what it saw, in plain words`);
      }
      // #3496: a pass says what the directory was held to, and what its first call took.
      assert(/answered its first call in \d+ms/.test(report.directory.detail), `real host: the directory says how long its first call took (${report.directory.detail})`);
      assert(
        report.directory.detail.includes(`within ${CONFIRM_LINE_CALL_MS}ms`) && /live directory/.test(report.directory.detail),
        `and that every later call was held to one call, the live directory's own pattern (${report.directory.detail})`,
      );
    }
    assert(w.groups.length > 0, "the probe reached the object");
    assert(
      w.groups.every((g) => g === CONFIRM_LINE_VERIFY_GROUP),
      `and every object it addressed is the verification group's (got ${[...new Set(w.groups)].join(", ")})`,
    );
    eq(w.instants.size, 3, "it used one instant per check, each its own");
    // #3460: it WRITES only to its own directory, and only READS the live one, so the
    // proof can never put a grouping in front of a real confirm.
    const puts = w.directoryCalls.filter((c) => c.op === "grouping-put");
    assert(puts.length > 0 && puts.every((c) => c.name === POOL_GROUPING_VERIFY_DIRECTORY), `and every directory put went to the verification directory (got ${JSON.stringify(puts)})`);
    const live = w.directoryCalls.filter((c) => c.name === POOL_GROUPING_DIRECTORY);
    assert(live.length === 1 && live[0]!.op === "grouping-get", `and the live directory was only read, once (got ${JSON.stringify(live)})`);
    assert(w.directoryCalls.every((c) => c.name === POOL_GROUPING_VERIFY_DIRECTORY || c.name === POOL_GROUPING_DIRECTORY), "and it addressed no other directory");
    // #3481: it left its own directory idle until it slept, and read it back from storage.
    assert(w.directoryWakes(POOL_GROUPING_VERIFY_DIRECTORY) >= 1, "the verification directory slept and woke during the run");
    assert(w.lastRunMs() >= PROBE_WAKE_IDLE_MS, `so the run took at least one idle spell (took ${w.lastRunMs()}ms)`);
    // Nothing left held, checked by THIS file against the host directly rather than by
    // the probe's own last check, which uses the same client it is checking (L345).
    for (const instant of w.instants) {
      const a = await w.handle(w.host, { v: CONFIRM_LINE_PROTOCOL, op: "enter", attempt: w.newId(), line: instant, waitMs: 0 });
      eq(a.kind, "lead", `afterwards, ${instant} is idle on the host: a newcomer leads at once`);
      if (typeof a.turn === "string") await w.handle(w.host, { v: CONFIRM_LINE_PROTOCOL, op: "done", turn: a.turn, verdict: { full: false } });
    }
  }

  // --- a planted defect for every outcome the probe can name (L151) ------------------
  /**
   * The longest any planted run spent before the wake check, and in it, on the virtual
   * clock: their sum is the slowest a run could be with both halves at their worst, held
   * against the command's deadline below.
   */
  let slowestBefore = 0;
  let slowestWake = 0;
  const measure = (w: ReturnType<typeof world>) => {
    slowestBefore = Math.max(slowestBefore, w.lastSplit().beforeWakeMs);
    slowestWake = Math.max(slowestWake, w.lastSplit().wakeMs);
  };
  const produced = new Map<ConfirmLineCheck, Set<CheckOutcome>>(CONFIRM_LINE_CHECKS.map((c) => [c, new Set(["passed" as CheckOutcome])]));
  const plant = async (
    name: string,
    defect: (w: ReturnType<typeof world>) => Send | null,
    expect: Partial<Record<ConfirmLineCheck, CheckOutcome>>,
    ns?: LineNamespace,
    /** #3460: a defect in the pool grouping directory instead, or as well. */
    directoryDefect?: (w: ReturnType<typeof world>) => void,
  ) => {
    const w = world();
    const send = defect(w);
    if (send) w.setSend(send);
    directoryDefect?.(w);
    const report = await w.run(ns);
    measure(w);
    assert(report !== "unsettled", `${name}: the probe still finishes`);
    if (report === "unsettled") return;
    for (const [check, outcome] of Object.entries(expect) as [ConfirmLineCheck, CheckOutcome][]) {
      eq(report[check].outcome, outcome, `${name}: ${check} ends ${outcome} (${report[check].detail})`);
      assert(PLAIN.test(report[check].detail), `${name}: ${check}'s detail is plain words`);
    }
    for (const check of CONFIRM_LINE_CHECKS) produced.get(check)?.add(report[check].outcome);
    assert(!CONFIRM_LINE_CHECKS.every((c) => report[c].outcome === "passed"), `${name}: the defect is not reported as a healthy line (${outcomes(report)})`);
  };
  const v = CONFIRM_LINE_PROTOCOL;

  // Unreachable: the object refuses every call, so the client falls back to the isolate's
  // own line, which is the state the per isolate fallback hides in production.
  await plant(
    "unreachable",
    () => async () => {
      throw new Error("the object refused");
    },
    { full: "unreachable", notFull: "unreachable", abandoned: "unreachable", nothingHeld: "unreachable" },
  );

  // Every call reaches a DIFFERENT instance: the failure #3325 exists to end, one line
  // per isolate. Every second confirm leads beside the first.
  await plant("a new instance per call", (w) => (m) => w.handle(w.newHost(), m), { full: "led-beside", notFull: "led-beside", abandoned: "led-beside" });

  // A full verdict that does not settle the followers.
  await plant(
    "a full verdict read as not full",
    (w) => (m) => w.handle(w.host, m.op === "done" ? { ...m, verdict: { full: false } } : m),
    { full: "not-settled", notFull: "passed", abandoned: "passed", nothingHeld: "passed" },
  );

  // A not full verdict that settles them anyway.
  await plant(
    "a not full verdict read as full",
    (w) => (m) =>
      w.handle(w.host, m.op === "done" && (m.verdict as Message | undefined)?.full === false ? { ...m, verdict: { full: true, refusal: "taken", settled: null } } : m),
    { full: "passed", notFull: "not-handed-on", abandoned: "passed" },
  );

  // The verdict never arrives, so the follower is freed only by the leader's lease.
  await plant(
    "a report that never reaches the object",
    (w) => (m) => (m.op === "done" ? Promise.resolve({ ok: true }) : w.handle(w.host, m)),
    { full: "not-settled", notFull: "not-handed-on", nothingHeld: "held" },
  );

  // The same lost verdict, sent late in the lease. Every enter answers just inside its
  // deadline, so most of the leader's lease is spent before it reports, and the report
  // is lost both times the client tries it, which takes two call deadlines. The lease
  // then frees the follower moments after the report call gives up. The hand on is timed
  // from when the verdict was SENT: timed from the report call's RETURN, a lease running
  // out reads as a prompt hand on.
  await plant(
    "a lost verdict sent late in the lease",
    (w) => async (m) => {
      if (m.op === "done") return new Promise<Message>(() => {});
      const a = await w.handle(w.host, m);
      if (m.op === "enter") await new Promise<void>((r) => w.timer(CONFIRM_LINE_CALL_MS - 50, r));
      return a;
    },
    { notFull: "not-handed-on" },
  );

  // No acknowledgement window: something acks every lead on the caller's behalf, so an
  // abandoned leader holds the line for a whole lease.
  await plant(
    "a lead acknowledged by nobody's caller",
    (w) => async (m) => {
      const a = await w.handle(w.host, m);
      if (a.kind === "lead" && typeof a.turn === "string") await w.handle(w.host, { v, op: "ack", turn: a.turn });
      return a;
    },
    { full: "passed", notFull: "passed", abandoned: "freed-late" },
  );

  // A lead kept alive forever: every call renews every lead the object ever granted.
  await plant(
    "a lead nothing lets go of",
    (w) => {
      const granted = new Set<string>();
      return async (m) => {
        for (const turn of granted) {
          const r = await w.handle(w.host, { v, op: "renew", turn });
          if (r.kind === "gone") granted.delete(turn);
        }
        const a = await w.handle(w.host, m);
        if (a.kind === "lead" && typeof a.turn === "string") granted.add(a.turn);
        return a;
      };
    },
    { abandoned: "not-freed" },
  );

  // An instant nobody has used is already held, so the first confirm cannot lead.
  await plant(
    "a line already held",
    (w) => {
      const seen = new Set<string>();
      return async (m) => {
        if (m.op === "enter" && typeof m.line === "string" && !seen.has(m.line)) {
          seen.add(m.line);
          const p = await w.handle(w.host, { v, op: "enter", attempt: w.newId(), line: m.line, waitMs: 0 });
          if (typeof p.turn === "string") await w.handle(w.host, { v, op: "ack", turn: p.turn });
        }
        return w.handle(w.host, m);
      };
    },
    { full: "idle-not-led", notFull: "idle-not-led", abandoned: "idle-not-led" },
  );

  // The probe's own code throwing, which is never a finding about the object.
  await plant(
    "a transport that cannot be built",
    () => null,
    { full: "errored", notFull: "errored", abandoned: "errored", nothingHeld: "errored", directory: "errored", directoryWake: "errored" },
    {
      stubFor() {
        throw new Error("no stub for that group");
      },
    },
    (w) =>
      w.setDirectoryFor(() => {
        throw new Error("no stub for that directory");
      }),
  );

  // --- #3460: the pool grouping directory, a planted defect for each of its outcomes ---
  const healthyLine = () => null;
  await plant("a directory that cannot be reached", healthyLine, { directory: "directory-unreachable", directoryWake: "directory-unreachable", full: "passed" }, undefined, (w) =>
    w.setDirectorySend(async () => {
      throw new Error("the directory refused");
    }),
  );
  await plant("a directory that forgets what it is given", healthyLine, { directory: "not-stored", directoryWake: "not-stored" }, undefined, (w) =>
    w.setDirectorySend(async (name, m) => (m.op === "grouping-get" ? { kind: "grouping", snapshot: null } : w.handleDirectory(name, m))),
  );
  await plant("a directory that refuses every put", healthyLine, { directory: "not-stored", directoryWake: "not-stored" }, undefined, (w) =>
    w.setDirectorySend(async (name, m) => (m.op === "grouping-put" ? { kind: "bad", why: "a pool grouping message on a confirm line" } : w.handleDirectory(name, m))),
  );
  await plant("a directory where an older put wins", healthyLine, { directory: "older-won" }, undefined, (w) => {
    // Stores whatever it was handed last, newest or not.
    let last: unknown = null;
    w.setDirectorySend(async (name, m) => {
      if (name !== POOL_GROUPING_VERIFY_DIRECTORY) return w.handleDirectory(name, m);
      if (m.op === "grouping-put") {
        last = m.snapshot;
        return { kind: "stored" };
      }
      return { kind: "grouping", snapshot: last };
    });
  });
  await plant("no live grouping", healthyLine, { directory: "no-grouping" }, undefined, (w) => w.setLiveSeed("none"));
  await plant("a stale live grouping", healthyLine, { directory: "grouping-unusable" }, undefined, (w) => w.setLiveSeed("stale"));
  await plant("a live grouping of another format", healthyLine, { directory: "grouping-unusable" }, undefined, (w) => w.setLiveSeed("other-format"));

  // --- #3481: the directory after an idle sleep, a planted defect for each outcome -----
  // A defect that acts "after the wait" counts from the wake check's own put (`isWakePut`).
  //
  // A platform that never discards an idle object: every read after the wait is answered
  // from memory, so a wake was never seen. Never a pass (L98): nothing was proved about
  // storage surviving a sleep.
  await plant("a platform that never puts the directory to sleep", healthyLine, { directoryWake: "wake-unobserved", directory: "passed", full: "passed" }, undefined, (w) =>
    w.setDirectoryPlatform({ idleMs: Infinity }),
  );
  // Control (L159): the same fixture with a window one millisecond longer than the probe's
  // spell. The healthy world passes only because its window sits inside the spell, so a
  // pass is never something the probe produces by construction.
  await plant("a platform whose window is longer than the probe's spell", healthyLine, { directoryWake: "wake-unobserved" }, undefined, (w) =>
    w.setDirectoryPlatform({ idleMs: PROBE_WAKE_IDLE_MS + 1 }),
  );
  // A directory older than the field answers without saying where from, so a woken
  // instance cannot be told from one that never slept.
  await plant("a directory that does not say where it answered from", healthyLine, { directoryWake: "wake-unobserved" }, undefined, (w) =>
    w.setDirectorySend(async (name, m) => {
      const answer = { ...(await w.handleDirectory(name, m)) };
      delete answer.from;
      return answer;
    }),
  );
  // Storage that does not survive the sleep: the woken instance reads nothing back, which
  // is the empty directory #3479 fixed.
  await plant("a directory whose storage does not survive its sleep", healthyLine, { directoryWake: "lost-after-idle" }, undefined, (w) =>
    w.setDirectoryPlatform({ idleMs: PLATFORM_HIBERNATE_AFTER_MS, storageOnWake: () => memoryGroupingStorage() }),
  );
  // A woken instance that cannot read its storage refuses the get (L215), and a server
  // reading it keys by code exactly as if it had read nothing.
  await plant("a woken directory that cannot read its storage", healthyLine, { directoryWake: "lost-after-idle" }, undefined, (w) =>
    w.setDirectoryPlatform({
      idleMs: PLATFORM_HIBERNATE_AFTER_MS,
      storageOnWake: (kept) => ({
        get: async () => {
          throw new Error("storage is down");
        },
        put: (key, value) => kept.put(key, value),
      }),
    }),
  );
  // Awake the whole time and the grouping gone anyway: lost while idle, said as the memory
  // it was answered from rather than blamed on a wake.
  await plant("a directory that drops what it holds while idle", healthyLine, { directoryWake: "lost-after-idle" }, undefined, (w) => {
    w.setDirectoryPlatform({ idleMs: Infinity });
    let waitingSince: number | null = null;
    w.setDirectorySend(async (name, m) => {
      const answer = await w.handleDirectory(name, m);
      if (isWakePut(name, m)) waitingSince = w.now();
      const waited = waitingSince !== null && w.now() - waitingSince >= PROBE_WAKE_IDLE_MS;
      return name === POOL_GROUPING_VERIFY_DIRECTORY && m.op === "grouping-get" && waited ? { ...answer, snapshot: null } : answer;
    });
  });
  // The directory stops answering while it is left idle.
  await plant("a directory that stops answering while idle", healthyLine, { directoryWake: "directory-unreachable" }, undefined, (w) => {
    let waitingSince: number | null = null;
    w.setDirectorySend(async (name, m) => {
      const waited = waitingSince !== null && w.now() - waitingSince >= PROBE_WAKE_IDLE_MS;
      if (name === POOL_GROUPING_VERIFY_DIRECTORY && m.op === "grouping-get" && waited) throw new Error("the directory refused");
      if (isWakePut(name, m)) waitingSince = w.now();
      return w.handleDirectory(name, m);
    });
  });

  // --- #3496: a directory call that misses its bound says when it really answered -----
  // The daily proof failed on 2026-10-07 with "no answer within 1000ms", which reads the
  // same for an object a few milliseconds slow to start as for one that is hung. The
  // platform's own records put that put's answer about 1.0s after it was sent, so the
  // difference was tens of milliseconds, and nothing in the message could say so. A call
  // that misses its bound is still the same finding; it now also says when the answer
  // came, or that it never did inside the probe's watch.
  /** Hold the `nth` call (from 1) the probe makes to directory `name` for `ms`, or for ever, then answer it, or fail it. */
  const holdCall = (w: ReturnType<typeof world>, target: { name: string; nth: number; ms: number | "never"; fail?: boolean }) => {
    let seen = 0;
    w.setDirectorySend(async (name, m) => {
      if (name === target.name && ++seen === target.nth) {
        if (target.ms === "never") return new Promise<Message>(() => {});
        const ms = target.ms;
        await new Promise<void>((resolve) => w.timer(ms, () => resolve()));
        if (target.fail) throw new Error("the directory refused");
      }
      return w.handleDirectory(name, m);
    });
  };
  const runHeld = async (label: string, target: Parameters<typeof holdCall>[1]): Promise<ProbeReport | null> => {
    const w = world();
    holdCall(w, target);
    const report = await w.run();
    measure(w);
    assert(report !== "unsettled", `${label}: the probe still finishes`);
    return report === "unsettled" ? null : report;
  };
  assert(PROBE_LATE_ANSWER_MS > CONFIRM_LINE_CALL_MS, `the probe watches a call that missed its bound for longer than the bound itself (${PROBE_LATE_ANSWER_MS}ms)`);
  {
    const r = await runHeld("a live get answered late", { name: POOL_GROUPING_DIRECTORY, nth: 1, ms: 1043 });
    if (r) {
      eq(r.directory.outcome, "directory-unreachable", `a live get answered past one call is still a call that did not answer in time (${r.directory.detail})`);
      assert(r.directory.detail.includes(`no answer within ${CONFIRM_LINE_CALL_MS}ms`), `and it names the bound it missed (${r.directory.detail})`);
      assert(r.directory.detail.includes("it answered 1043ms after it was sent"), `and when the answer really came, so a slow start is told from a hung object (${r.directory.detail})`);
      assert(PLAIN.test(r.directory.detail), "in plain words");
      eq(r.directoryWake.outcome, "passed", "and the verification directory, which answered in time, still passes its wake");
    }
  }
  {
    const r = await runHeld("a live get that fails late", { name: POOL_GROUPING_DIRECTORY, nth: 1, ms: 1300, fail: true });
    if (r) {
      eq(r.directory.outcome, "directory-unreachable", `a live get that failed past one call did not answer in time (${r.directory.detail})`);
      assert(
        r.directory.detail.includes("it failed 1300ms after it was sent") && r.directory.detail.includes("the directory refused"),
        `and it says when it failed and why, rather than that it answered (${r.directory.detail})`,
      );
    }
  }
  {
    const r = await runHeld("a live get that never answers", { name: POOL_GROUPING_DIRECTORY, nth: 1, ms: "never" });
    if (r) {
      eq(r.directory.outcome, "directory-unreachable", `a live get that never answers did not answer (${r.directory.detail})`);
      assert(
        r.directory.detail.includes(`no answer within ${CONFIRM_LINE_CALL_MS}ms, nor at all in the ${PROBE_LATE_ANSWER_MS}ms the probe watched for one`),
        `and it says it watched the whole while and saw nothing, so a hung object is never read as a slow one (${r.directory.detail})`,
      );
    }
  }
  {
    // The verification directory hung outright: both of its checks say so, and the probe
    // still answers, so the command is not held to its own deadline by a hung object.
    const w = world();
    w.setDirectorySend(async (name, m) => (name === POOL_GROUPING_VERIFY_DIRECTORY ? new Promise<Message>(() => {}) : w.handleDirectory(name, m)));
    const r = await w.run();
    measure(w);
    assert(r !== "unsettled", "a hung verification directory: the probe still finishes");
    if (r !== "unsettled") {
      for (const check of ["directory", "directoryWake"] as const) {
        eq(r[check].outcome, "directory-unreachable", `a hung verification directory: ${check} says it did not answer (${r[check].detail})`);
        assert(r[check].detail.includes(`nor at all in the ${PROBE_LATE_ANSWER_MS}ms`), `and that it never answered while watched (${r[check].detail})`);
      }
    }
  }

  {
    // A call that resolves with nothing is no answer, said as one, never a reading the
    // check then trips over in its own code (which would end it as errored, the probe's fault).
    const w = world();
    w.setDirectorySend(async (name, m) => (name === POOL_GROUPING_DIRECTORY ? (null as unknown as Message) : w.handleDirectory(name, m)));
    const r = await w.run();
    measure(w);
    assert(r !== "unsettled", "a live get that resolves with nothing: the probe still finishes");
    if (r !== "unsettled") {
      eq(r.directory.outcome, "directory-unreachable", `a live get that resolves with nothing did not answer (${r.directory.detail})`);
      assert(r.directory.detail.includes("an answer that is not a message"), `and says what came back instead (${r.directory.detail})`);
    }
  }

  // --- #3496: what the check holds the verification directory to ----------------------
  // The verification directory is touched only by this proof, so its first call of a run
  // meets an object idle since yesterday, a cold start: on 2026-10-07 the platform's own
  // records put it about a second after the call was sent, twice. The LIVE directory never
  // meets that: the recompute lane calls it every minute, and its puts after a minute idle
  // reached it no later than those after a few seconds. So every call after the first is
  // held to one call, the live directory's real pattern, and the first is held only to the
  // longest a server's own fetch waits for the grouping, and says how long it took.
  eq(PROBE_DIRECTORY_FIRST_CALL_MS, POOL_GROUPING_FETCH_GIVE_UP_MS, "the verification directory's first call is held to the longest a server's own fetch of the grouping waits, and no longer");
  assert(PROBE_DIRECTORY_FIRST_CALL_MS > CONFIRM_LINE_CALL_MS, "which is looser than one call, the bound every later call is held to");
  assert(PROBE_LATE_ANSWER_MS > PROBE_DIRECTORY_FIRST_CALL_MS, "and a first call that misses even that is still watched for its real answer");
  {
    const r = await runHeld("a cold first call", { name: POOL_GROUPING_VERIFY_DIRECTORY, nth: 1, ms: 1500 });
    if (r) {
      eq(r.directory.outcome, "passed", `a first call that meets a cold start and answers inside a server's own wait passes (${r.directory.detail})`);
      assert(r.directory.detail.includes("answered its first call in 1500ms"), `and says how long the cold start took, so the number is in every day's log (${r.directory.detail})`);
      eq(r.directoryWake.outcome, "passed", "and the wake check after it passes");
    }
  }
  {
    // Control (L159): the same delay on any LATER call is a directory already awake, which
    // is what the live one is, so it still fails. The loose bound is the first call's alone.
    const r = await runHeld("a slow call after the first", { name: POOL_GROUPING_VERIFY_DIRECTORY, nth: 2, ms: 1500 });
    if (r) {
      eq(r.directory.outcome, "directory-unreachable", `a call to a directory already awake that takes 1500ms did not answer in time (${r.directory.detail})`);
      assert(r.directory.detail.includes(`no answer within ${CONFIRM_LINE_CALL_MS}ms; it answered 1500ms after it was sent`), `held to one call (${r.directory.detail})`);
    }
  }
  {
    const r = await runHeld("a first call slower than any server waits", { name: POOL_GROUPING_VERIFY_DIRECTORY, nth: 1, ms: 2600 });
    if (r) {
      eq(r.directory.outcome, "directory-unreachable", `a first call slower than a server's own fetch waits did not answer in time (${r.directory.detail})`);
      assert(
        r.directory.detail.includes("its first call") && r.directory.detail.includes(`no answer within ${PROBE_DIRECTORY_FIRST_CALL_MS}ms; it answered 2600ms after it was sent`),
        `and says it was the first call, the bound it missed, and when it answered (${r.directory.detail})`,
      );
    }
  }

  // The wake loop, past a first spell the runtime stretched. The first read after the wait
  // finds the directory still awake and holding its grouping, so the probe waits another
  // spell rather than calling it either way, and the second read finds it woken.
  {
    const w = world();
    w.setDirectoryPlatform({ idleMs: Infinity });
    let waitingSince: number | null = null;
    w.setDirectorySend(async (name, m) => {
      const answer = await w.handleDirectory(name, m);
      if (isWakePut(name, m)) waitingSince = w.now();
      // After the first spell, the runtime starts putting idle objects to sleep again.
      if (name === POOL_GROUPING_VERIFY_DIRECTORY && waitingSince !== null && w.now() - waitingSince >= PROBE_WAKE_IDLE_MS) w.setDirectoryIdleMs(PLATFORM_HIBERNATE_AFTER_MS);
      return answer;
    });
    const report = await w.run();
    measure(w);
    assert(report !== "unsettled", "a stretched first spell: the probe finishes");
    if (report !== "unsettled") {
      eq(report.directoryWake.outcome, "passed", `a stretched first spell: the second read, from storage, passes (${report.directoryWake.detail})`);
      assert(/read 2 of /.test(report.directoryWake.detail), `and says it took the second read (${report.directoryWake.detail})`);
    }
    // Its own reads never kept the object awake: after the put, each read is a whole spell
    // after the call before it.
    const verify = w.directoryCalls.filter((c) => c.name === POOL_GROUPING_VERIFY_DIRECTORY);
    const [before, first, second] = verify.slice(-3);
    assert(
      before !== undefined && first !== undefined && second !== undefined && first.at - before.at >= PROBE_WAKE_IDLE_MS && second.at - first.at >= PROBE_WAKE_IDLE_MS,
      `a stretched first spell: each read after the put is a whole spell after the call before it (${JSON.stringify(verify.slice(-3))})`,
    );
  }
  {
    // And when no read ever answers from storage it gives up after its reads rather than
    // waiting for ever (L110), every one of them a whole spell after the call before it.
    const w = world();
    w.setDirectoryPlatform({ idleMs: Infinity });
    const report = await w.run();
    measure(w);
    assert(report !== "unsettled" && report.directoryWake.outcome === "wake-unobserved", "an awake directory: the probe ends unobserved");
    const verify = w.directoryCalls.filter((c) => c.name === POOL_GROUPING_VERIFY_DIRECTORY);
    const tail = verify.slice(-(PROBE_WAKE_READS + 1));
    const gaps = tail.slice(1).map((c, i) => c.at - tail[i]!.at);
    assert(
      tail.slice(1).every((c) => c.op === "grouping-get") && gaps.length === PROBE_WAKE_READS && gaps.every((g) => g >= PROBE_WAKE_IDLE_MS),
      `an awake directory: exactly ${PROBE_WAKE_READS} reads after the wait, each a whole spell after the call before it (gaps ${gaps.join(", ")}ms)`,
    );
    const callsAfter = verify.filter((c) => c.at > tail[0]!.at);
    eq(callsAfter.length, PROBE_WAKE_READS, "and nothing else touched the directory while it was meant to be idle");
    if (report !== "unsettled") assert(/memory/.test(report.directoryWake.detail), `and it says the directory answered from memory (${report.directoryWake.detail})`);
  }

  // The command must outwait the slowest probe, with room (L743): a deadline inside it
  // reads a slow but honest run as no reply at all. Measured as the slowest line checks
  // plus the slowest wake, the worst both halves can be together.
  const worst = slowestBefore + slowestWake;
  assert(slowestBefore > 0 && slowestWake >= PROBE_WAKE_READS * PROBE_WAKE_IDLE_MS, `both halves were measured (${slowestBefore}ms before the wake check, ${slowestWake}ms in it)`);
  assert(worst < 0.8 * REPLY_DEADLINE_MS, `the slowest the probe can take (${worst}ms) sits well inside the command's ${REPLY_DEADLINE_MS}ms reply deadline`);

  for (const check of CONFIRM_LINE_CHECKS) {
    const declared = [...CHECK_CAN_END_ON[check]].sort();
    const seen = [...(produced.get(check) ?? [])].sort();
    eq(seen.join(","), declared.join(","), `${check}: every outcome it declares was produced by some planted defect, and it produced nothing it does not declare`);
  }
  eq(
    [...new Set(CONFIRM_LINE_CHECKS.flatMap((c) => [...CHECK_CAN_END_ON[c]]))].sort().join(","),
    [...CHECK_OUTCOMES].sort().join(","),
    "and every outcome in the vocabulary belongs to some check",
  );

  // --- the hand on is timed from when the report LEFT the leader ---------------------
  // The leader's client retries a report that is not answered within one call, so the
  // report can return long after the line was handed on. Timed from its return, a hand on
  // that took a second and a half reads as instant (review of #3340).
  const millis = (detail: string) => Number(detail.match(/(\d+)ms/)?.[1] ?? NaN);
  {
    // The first report reaches the object 1500ms after it was sent, past one call, so the
    // client gives up on it and sends a second; the follower leads at 1500ms, while the
    // report is still being awaited. That is the verdict handing on inside the report's own
    // two calls, so it passes, and it must be measured as the 1500ms it took.
    const w = world();
    const later = (ms: number) => new Promise<void>((resolve) => w.timer(ms, () => resolve()));
    w.setSend(async (m) => {
      if (m.op === "done") await later(1500);
      return w.handle(w.host, m);
    });
    const report = await w.run();
    assert(report !== "unsettled", "a slow report: the probe finishes");
    if (report !== "unsettled") {
      eq(report.notFull.outcome, "passed", `a slow report: a verdict that arrived late, inside the report's two calls, still handed the line on (${report.notFull.detail})`);
      const ms = millis(report.notFull.detail);
      assert(ms >= 1450 && ms <= 1600, `and the time it measures is the hand on's own, about 1500ms, not zero (measured ${ms}ms)`);
      eq(report.full.outcome, "passed", "a slow report: the full verdict still refuses the follower, since that check has no clock");
    }
  }
  {
    // The counterpart: the object acts on the report at once and only its ANSWER is late.
    // The hand on lands during the report await, and is measured as the instant it was.
    const w = world();
    const later = (ms: number) => new Promise<void>((resolve) => w.timer(ms, () => resolve()));
    w.setSend(async (m) => {
      const answer = await w.handle(w.host, m);
      if (m.op === "done") await later(600);
      return answer;
    });
    const report = await w.run();
    assert(report !== "unsettled", "a slow answer: the probe finishes");
    if (report !== "unsettled") {
      eq(report.notFull.outcome, "passed", `a slow ANSWER to a report the object acted on at once is a prompt hand on (${report.notFull.detail})`);
      const ms = millis(report.notFull.detail);
      assert(ms >= 0 && ms <= 50, `and it measures the hand on from the report leaving, not from the answer coming back (measured ${ms}ms)`);
    }
  }
  {
    // The decision itself, at its edges, including the one the probe's own sequencing makes
    // rare: a follower led BEFORE the report left, which no verdict can explain.
    eq(judgeHandOn(5_000, 5_000).outcome, "passed", "a hand on at the moment the report left is prompt");
    eq(judgeHandOn(5_000 + VERDICT_REACHES_FOLLOWER_WITHIN_MS, 5_000).outcome, "passed", "and so is one exactly the report's two calls after");
    eq(judgeHandOn(5_001 + VERDICT_REACHES_FOLLOWER_WITHIN_MS, 5_000).outcome, "not-handed-on", "one past that is a lease, not the verdict");
    const early = judgeHandOn(4_900, 5_000);
    eq(early.outcome, "led-beside", "a follower led before the report left was led beside a holder, never clamped to a prompt hand on");
    eq(millis(early.detail), 100, "and says by how much");
  }

  // --- reading the endpoint's reply ------------------------------------------------
  const allPassed = Object.fromEntries(CONFIRM_LINE_CHECKS.map((c) => [c, { outcome: "passed", detail: `${c} answered as the rules say` }]));
  const reply = (checks: unknown, reason: string = CONFIRM_LINE_PROBE_REASON.checked) => JSON.stringify({ reason, group: CONFIRM_LINE_VERIFY_GROUP, checks });
  {
    const out = readConfirmLineOutcome(200, reply(allPassed));
    eq(out.kind, "checked", "a checked reply is read as checked");
    const v0 = judgeConfirmLineProbe(out);
    assert(v0.ok, "and every check passing is the one pass");
    eq(v0.ok ? 0 : v0.exitCode, CONFIRM_LINE_EXIT.passed, "on exit 0");
  }
  {
    const missing = { ...allPassed } as Record<string, unknown>;
    delete missing.abandoned;
    const out = readConfirmLineOutcome(200, reply(missing));
    eq(out.kind, "incomplete", "a reply missing a check is incomplete, never a pass on the three it carried (L98)");
    assert(out.kind === "incomplete" && out.detail.includes("abandoned"), "and names the check it is missing");
  }
  {
    const wrong = { ...allPassed, notFull: { outcome: "freed-late", detail: "x" } };
    eq(readConfirmLineOutcome(200, reply(wrong)).kind, "incomplete", "an outcome that check can never end on is not believed");
    const unknown = { ...allPassed, full: { outcome: "probably-fine", detail: "x" } };
    eq(readConfirmLineOutcome(200, reply(unknown)).kind, "incomplete", "nor is one this command does not know");
    const noDetail = { ...allPassed, full: { outcome: "passed" } };
    eq(readConfirmLineOutcome(200, reply(noDetail)).kind, "incomplete", "nor a check with no words about what it saw");
  }
  eq(readConfirmLineOutcome(503, JSON.stringify({ reason: CONFIRM_LINE_PROBE_REASON.bindingMissing })).kind, "binding-missing", "a missing binding is its own outcome");
  eq(readConfirmLineOutcome(503, JSON.stringify({ reason: CONFIRM_LINE_PROBE_REASON.contextUnreadable })).kind, "context-unreadable", "an unreadable context is not a missing binding");
  eq(readConfirmLineOutcome(503, JSON.stringify({ error: "booking api not configured" })).kind, "not-configured", "a 503 with no reason of ours is the endpoint disabled");
  eq(readConfirmLineOutcome(401, JSON.stringify({ error: "unauthorized" })).kind, "unauthorized", "a refused key is its own outcome");
  eq(readConfirmLineOutcome(404, "<html>not found</html>").kind, "endpoint-missing", "a 404 is a deployment older than the endpoint");
  eq(readConfirmLineOutcome(500, "<html>error 1101</html>").kind, "unreadable-reply", "a reply this endpoint never produces is refused, not guessed at");
  eq(readConfirmLineOutcome(200, JSON.stringify({ reason: "checked" })).kind, "incomplete", "a checked reply with no checks at all is incomplete");

  // --- judging: every ending on its own code and its own sentence (L11) -------------
  {
    const codes = Object.entries(CONFIRM_LINE_EXIT).filter(([n]) => n !== "passed").map(([, c]) => c);
    eq(new Set(codes).size, codes.length, "every refusal has its own exit code");
    assert(codes.every((c) => c > 0), "and none of them is zero, so no refusal can read as a pass");

    const failing = (check: ConfirmLineCheck, outcome: CheckOutcome): ProbeOutcome => ({
      kind: "checked",
      checks: { ...(allPassed as Record<ConfirmLineCheck, { outcome: CheckOutcome; detail: string }>), [check]: { outcome, detail: `what ${check} saw` } },
    });
    const endings: ProbeOutcome[] = [
      { kind: "no-answer", detail: "fetch failed" },
      { kind: "unreadable-reply", detail: "HTTP 500" },
      { kind: "unauthorized" },
      { kind: "not-configured" },
      { kind: "endpoint-missing" },
      { kind: "context-unreadable" },
      { kind: "binding-missing" },
      { kind: "incomplete", detail: "no abandoned check" },
    ];
    for (const check of CONFIRM_LINE_CHECKS) {
      for (const outcome of CHECK_CAN_END_ON[check]) if (outcome !== "passed") endings.push(failing(check, outcome));
    }
    const byCode = new Map<number, Set<string>>();
    const messages = new Set<string>();
    for (const e of endings) {
      const verdict = judgeConfirmLineProbe(e);
      assert(!verdict.ok, `${JSON.stringify(e).slice(0, 80)} is refused`);
      if (verdict.ok) continue;
      assert(verdict.message.trim().length > 40 && PLAIN.test(verdict.message), `exit ${verdict.exitCode} says something a reader can act on, in plain words`);
      if (!byCode.has(verdict.exitCode)) byCode.set(verdict.exitCode, new Set());
      byCode.get(verdict.exitCode)!.add(verdict.message.split("\n")[0] as string);
      messages.add(verdict.message.split("\n")[0] as string);
    }
    const reached = [...byCode.keys()].sort((a, b) => a - b);
    const declared = Object.values(CONFIRM_LINE_EXIT).filter((c) => c !== CONFIRM_LINE_EXIT.passed && c !== CONFIRM_LINE_EXIT.misconfigured).sort((a, b) => a - b);
    eq(reached.join(","), declared.join(","), "every exit code but the two decided before anything is asked is reached by some ending, and nothing else is");
    eq(messages.size, [...byCode.values()].reduce((n, s) => n + s.size, 0), "and no two codes share an opening sentence");
    for (const [code, firsts] of byCode) {
      eq(firsts.size, 1, `exit ${code} always opens with the same sentence, so a reader learns one meaning per code`);
    }

    // The worst finding names the run, and the others are still said.
    const two: ProbeOutcome = {
      kind: "checked",
      checks: {
        ...(allPassed as Record<ConfirmLineCheck, { outcome: CheckOutcome; detail: string }>),
        abandoned: { outcome: "freed-late", detail: "freed after 4100ms" },
        full: { outcome: "led-beside", detail: "led at once" },
      },
    };
    const both = judgeConfirmLineProbe(two);
    assert(!both.ok && both.exitCode === CONFIRM_LINE_EXIT.ledBeside, "a line that excludes nobody outranks a lead freed late");
    assert(!both.ok && both.message.includes("4100ms"), "and the lesser finding is still in the message, so it is not lost behind the worse one");
    const unreachableToo = judgeConfirmLineProbe({
      kind: "checked",
      checks: { ...two.checks, notFull: { outcome: "unreachable", detail: "reach-timeout" } },
    });
    assert(!unreachableToo.ok && unreachableToo.exitCode === CONFIRM_LINE_EXIT.objectUnreachable, "and an object that did not answer outranks everything it answered wrongly");
  }

  // --- the documented exits are the shipped ones (L210) --------------------------------
  {
    const doc = readFileSync(join(ROOT, "docs/verify-commands.md"), "utf8");
    const heading = "# Proving the shared confirm line answers";
    const start = doc.indexOf(heading);
    assert(start !== -1, "docs/verify-commands.md documents the command");
    const rest = doc.slice(start + heading.length);
    const next = rest.indexOf("\n# ");
    const section = next === -1 ? rest : rest.slice(0, next);
    assert(section.includes("pnpm verify:confirm-line"), "and says how to run it, by the name package.json wires");
    assert(/burst-counter\.yml/.test(section), "and names the scheduled workflow that runs it");
    assert(/verdict:confirm-line/.test(section), "and the verdict lane it stamps");
    assert(/only a run that measured/i.test(section), "and that only a MEASURED verdict may stamp");
    assert(/cannot prove/i.test(section) && /isolates/i.test(section) && /load run/i.test(section), "and says plainly that it cannot prove two isolates share one object, which only the load run can");
    const documented = new Set<number>();
    for (const line of section.split("\n")) {
      const m = line.match(/^\|\s*(\d+)\s*\|/);
      if (m) documented.add(Number(m[1]));
    }
    eq(
      [...documented].sort((a, b) => a - b).join(","),
      Object.values(CONFIRM_LINE_EXIT).sort((a, b) => a - b).join(","),
      "every exit code the command can end on is documented, and nothing it cannot end on",
    );
    const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    assert(/`verify:confirm-line`/.test(agents), "AGENTS.md lists the command beside the burst counter's");

    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const wired = pkg.scripts?.["verify:confirm-line"] ?? "";
    assert(wired.includes("scripts/verify-confirm-line-live.ts"), "the documented command really runs the live script");
    assert(!wired.includes("scripts/test-"), "which is not named test-*.ts, because it talks to a live deployment");
  }

  // --- the route takes nothing from the request, and never asks the switch ------------
  {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const route = strip(readFileSync(join(ROOT, "src/app/api/smoke/confirm-line/route.ts"), "utf8"));
    assert(/runConfirmLineProbe\(/.test(route), "the route runs the probe this file drives");
    assert(/durableLineNamespace\(/.test(route), "through the production transport");
    assert(/CANARY_CALLERS/.test(route) && /authenticateBearer\(/.test(route), "behind the canary's own Bearer key, like the burst counter's endpoint");
    assert(!/\.json\(\)|searchParams|formData|req\.text/.test(route), "and reads nothing from the request, so no caller can name a group or an instant");
    assert(!/readSharedConfirmLine|shared-line-switch/.test(route), "and never reads the stored switch, which decides real confirms rather than this probe");
  }

  finish();
}

void main();
