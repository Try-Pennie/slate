/**
 * A confirm's own work, told apart from the isolate starting up (#2340).
 *
 * Run 34889873261 judged the request path at a CPU p99 of 2,988ms against the
 * 2,500ms request budget, and the confirms over two seconds of CPU were not doing
 * more confirm work than the ones under half a second: their stage profiles are
 * the same shape. What differs is the three to four and a half seconds BEFORE the
 * profile starts, which is the Next.js server bundle being evaluated on a fresh
 * isolate and charged in full to whichever request that isolate serves first.
 *
 * That makes the CPU bar unpassable for a reason nobody should fix. A ten minute
 * run at sixty a minute spins up a few dozen isolates, and a p99 over six to eight
 * hundred requests is exactly the top few percent, which is where those requests
 * sit. The platform's own CPU percentile cannot separate them: it is one number
 * per invocation with nothing in it saying whether that invocation also paid for
 * the isolate.
 *
 * So the split is read from the run's OWN archived log, which already carries both
 * halves: the invocation's start (`eventTimestamp`), and the confirm profile's
 * total, logged when the confirm finished. What is left over is everything before
 * the profile started.
 *
 * **This is WALL time, not CPU**, for the same reason the profile it reads is: the
 * runtime exposes no per request CPU figure. Anything drawn from it has to say
 * which it is.
 *
 * It computes no percentiles. The judge owns that, and owns the one implementation
 * of it (L41); this owns the reading.
 *
 * **The archive is NOT one object per line, despite the `.jsonl` name.** Measured
 * against run 34889873261's own artifact: 1,336 invocations over 179,056 lines,
 * because `wrangler tail --format json` PRETTY PRINTS each event. The first version
 * of this reader split on newlines and required each line to start with a brace,
 * which the real file satisfies 1,336 times with a bare `{` that parses as nothing.
 * It would have read ZERO confirms from every archive the run has ever produced,
 * and every fixture agreed with it because they were written by the same hand that
 * assumed the shape (L52). So the objects are scanned out of the text by brace
 * depth, and the fixtures are pretty printed the way the real file is.
 */

import { CONFIRM_LINE_TRACE_TAG, TRACED_CALL_MSG } from "../../src/lib/booking/confirm-line-object.ts";

/**
 * #3354: a confirm's wait in the shared line, split by the object's own log of each
 * call the confirm sent while it waited. `wait_line_ms` is the client's view; the
 * object logs each traced call and the runtime records its `wallTime`, so the wait
 * splits into three:
 *
 *   held      polls, which the object holds until the confirm's turn or a timeout:
 *             time spent behind a leader
 *   object    the object's own work on every other call sent while waiting (the
 *             lookahead, the enter, the ack)
 *   outside   the rest: network both ways, the object starting, and the client's own
 *             work between calls, the switch read among it
 *
 * Calls sent during the turn (claims, the report, the heartbeat) are not part of the
 * wait and are left out. A wait the object over accounts for is `impossible` rather
 * than a negative outside, and a traced confirm whose calls never reached the archive
 * is `missing` rather than a split of zeroes (L98).
 */
export interface LineSplit {
  /** Confirms on the shared line whose answer line carried a trace and a line span. */
  traced: number;
  /** Of those, the ones with at least one call found, which give a reading. */
  joined: number;
  /** Traced confirms none of whose calls are in the archive. */
  missing: number;
  /** Traced confirms whose calls took longer in the object than the whole wait. */
  impossible: number;
  /** Traced confirms with a call sent while waiting whose event carried no `wallTime`. */
  unreadable: number;
  heldMs: number[];
  objectMs: number[];
  outsideMs: number[];
}

/** The wait before the profile, cold and warm, for one script version or one leg. */
export interface SideWaits {
  cold: number[];
  warm: number[];
}

/** What one archived run says about the confirms in it. */
export interface ConfirmStartupReading {
  /** How many confirm profiles were read in full. */
  samples: number;
  /** How many of those were on an isolate that became ready inside that request. */
  cold: number;
  /** Each confirm's own wall time, from the profile itself. */
  handlerMs: number[];
  /** Each confirm's wall time before the profile started. */
  preProfileMs: number[];
  /** The same, for the confirms that paid for their isolate starting up. */
  coldPreProfileMs: number[];
  /** And for the ones that did not. */
  warmPreProfileMs: number[];
  /**
   * The runtime's own CPU reading for each confirm's invocation, split the same
   * way, and empty where the archive did not carry one.
   *
   * This is the number the CPU bar is about. The analytics API reports it as one
   * percentile over every invocation with nothing in it saying which invocations
   * it came from, which is exactly why a run could not tell a slow confirm from a
   * cold isolate. Per invocation, beside the isolate's age, it can.
   */
  coldCpuMs: number[];
  warmCpuMs: number[];
  /**
   * What each confirm's invocation went on doing AFTER the profile was logged.
   *
   * This is the span #2340 did not know it was measuring, and it is where the time
   * actually is. That issue computed ONE number, the invocation's wall minus the
   * profile's own total, and read it as the time BEFORE the handler started. It is
   * both sides at once. Measured on run 34889873261's own archive, 613 confirms:
   *
   *   | span                | 32 over 2s CPU | 409 under 0.5s CPU |
   *   |---------------------|----------------|--------------------|
   *   | before the profile  | 297ms          | 209ms              |
   *   | inside it           | 2,355ms        | 1,561ms            |
   *   | after it was logged | 2,758ms        | 258ms              |
   *
   * The expensive confirms are not starting up slowly. They are the ones whose
   * invocation carries on for seconds after the booking is written, which on this
   * path is the webhook send deferred by #884. The response has already gone, so no
   * lead waits for it, and the CPU it spends is still charged to the invocation the
   * CPU bar reads.
   *
   * Empty where the archive carried no `wallTime`, never zero, for the same reason
   * the CPU list is (L98).
   */
  afterProfileMs: number[];
  /**
   * Samples whose arithmetic cannot be right: a profile claiming more wall time
   * than its whole invocation took.
   *
   * Counted rather than clamped in silence. Their startup reads as zero, which is
   * the most flattering answer there is and indistinguishable from a genuinely
   * fast one (L98), so a reader has to be able to see how many of them there were.
   */
  impossible: number;
  /**
   * Lines that CARRY a confirm profile and could not be read as one.
   *
   * A line carrying no confirm profile at all is not counted here: wrangler prints
   * its own banner before the stream starts, and counting that would put a
   * permanent floor under a number somebody is meant to act on.
   */
  unreadable: number;
  /**
   * Lines that began as a tail event and are not readable JSON.
   *
   * Its own count, not folded into `unreadable`, because nothing can say whether
   * such a line held a confirm profile and the two send a reader somewhere
   * different (L11). It is not hypothetical: the archive is written by
   * `timeout 15m npx wrangler tail ... > results/tail.jsonl`, and a stream killed
   * on that timeout leaves its last line half written. Silently skipping it would
   * drop a reading and say nothing (L10).
   */
  unparsable: number;
  /**
   * #3354: the wait before the profile, by span, from each confirm's own marks
   * (`src/lib/booking/wait-marks.ts`), filed under the same cold or warm call as its
   * profile. Read from the `confirm answered` line of the SAME invocation, so a span
   * and its classification describe one request (L420). A span a confirm did not
   * carry, or carried unreadably, contributes nothing rather than a zero (L90).
   */
  waitSpans: { cold: Record<string, number[]>; warm: Record<string, number[]> };
  /** Profiles whose invocation logged a `confirm answered` line with marks or an invocation index. */
  markedSamples: number;
  /** The same, split by the cold or warm call, so each side says how many carried marks. */
  markedBySide: { cold: number; warm: number };
  /** Profiles whose invocation carried a readable Worker invocation index. */
  invocationIndexKnown: number;
  /** Of those, the confirms that were their isolate's FIRST run of the app (invocation index 0). */
  firstRequests: number;
  /**
   * First requests the module stamp read as warm. Such a request cannot have found
   * the confirm module already evaluated, so each one is a confirm missing from the
   * cold population the startup bar judges (L457).
   */
  firstRequestsReadWarm: number;
  /** #3354: the shared line's wait, split by the object's own log, cold and warm. */
  lineSplit: { cold: LineSplit; warm: LineSplit; orphanCalls: number };
  /** #3354: the wait before the profile by the Worker version that served it (`unknown` when the event named none). */
  byVersion: Record<string, SideWaits>;
  /** #3354: and by the load run leg that sent it (`none` when it named none). */
  byLeg: Record<string, SideWaits>;
}

/** The spans `wait-marks.ts` writes, in the order a confirm passes them. */
export const WAIT_SPAN_FIELDS = [
  "wait_route_ms",
  "wait_auth_ms",
  "wait_pre_line_ms",
  "wait_line_ms",
  "wait_decide_ms",
  "wait_to_profile_ms",
  "wait_total_ms",
] as const;

const ANSWER_MSG = 'msg="confirm answered"';

/** One log entry inside a tail event. */
interface TailLog {
  timestamp?: unknown;
  message?: unknown;
}

/** One event of `wrangler tail --format json`. */
interface TailEvent {
  eventTimestamp?: unknown;
  logs?: unknown;
  /**
   * The runtime's OWN per invocation readings, which the archive carries and which
   * nothing here knew about until the real artifact was read.
   *
   * `cpuTime` is the number the CPU bar is about, per invocation rather than as a
   * percentile with nothing in it saying which invocations it came from. That is
   * the whole reason the split could not be made from the analytics API.
   */
  cpuTime?: unknown;
  wallTime?: unknown;
  /** #3354: the Worker version that served the invocation. */
  scriptVersion?: { id?: unknown } | null;
}

/**
 * Every top level JSON object in the archive, however it is laid out.
 *
 * A brace depth scan rather than a line split, because the file is pretty printed
 * (see the header). String aware, so a brace inside a URL or a log message does
 * not open or close an object: the events carry request URLs and Slate's own log
 * lines, both of which contain braces.
 */
export function* tailObjects(archive: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < archive.length; i++) {
    const c = archive[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        yield archive.slice(start, i + 1);
        start = -1;
      } else if (depth < 0) {
        // A stray closing brace: the stream began mid object. Start again rather
        // than carrying a negative depth that would swallow every event after it.
        depth = 0;
      }
    }
  }
  // A final object left open is a stream killed mid write, which the caller counts.
  if (depth > 0 && start >= 0) yield archive.slice(start);
}

const TAG = "tag=confirm-profile";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A `key=value` field out of a line Slate's own formatter wrote. */
function field(line: string, key: string): number | null {
  const m = new RegExp(`(?:^|\\s)${key}=(-?\\d+(?:\\.\\d+)?)(?:\\s|$)`).exec(line);
  // Through the same guard as every other reading (L50). The pattern admits a
  // digit string long enough to parse as Infinity, and Infinity compares false
  // against every bound, which lands the reading on the permissive side with
  // nothing raised anywhere.
  return m ? num(Number(m[1])) : null;
}

/** The message of one log entry, however many arguments it was written with. */
function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.map((m) => (typeof m === "string" ? m : "")).join(" ");
  return "";
}

/**
 * Read one archived `wrangler tail --format json` file.
 *
 * Null when it holds no confirm profile at all, rather than a reading of zeroes: a
 * run whose archive never arrived and a run whose confirms cost nothing would
 * otherwise render the same (L98).
 */
export function readConfirmStartup(archive: string): ConfirmStartupReading | null {
  const reading: ConfirmStartupReading = {
    samples: 0,
    cold: 0,
    handlerMs: [],
    preProfileMs: [],
    coldPreProfileMs: [],
    warmPreProfileMs: [],
    coldCpuMs: [],
    warmCpuMs: [],
    afterProfileMs: [],
    impossible: 0,
    unreadable: 0,
    unparsable: 0,
    waitSpans: { cold: {}, warm: {} },
    markedSamples: 0,
    markedBySide: { cold: 0, warm: 0 },
    invocationIndexKnown: 0,
    firstRequests: 0,
    firstRequestsReadWarm: 0,
    lineSplit: { cold: emptySplit(), warm: emptySplit(), orphanCalls: 0 },
    byVersion: {},
    byLeg: {},
  };
  let sawAny = false;
  // #3354: the object's traced calls by trace, and the confirms that may own them,
  // joined once the whole archive is read (an object's calls usually arrive first).
  const objectCalls = new Map<string, { stage: string; op: string; wallMs: number | null }[]>();
  const tracedConfirms: { side: "cold" | "warm"; trace: string; shared: boolean; waitLineMs: number | null }[] = [];

  for (const raw of tailObjects(archive)) {
    let event: TailEvent;
    try {
      event = JSON.parse(raw) as TailEvent;
    } catch {
      // Counted rather than skipped. A truncated line is a reading this could not
      // make, and one dropped in silence leaves a reader taking the samples it did
      // read for the whole run (L10, L11).
      reading.unparsable += 1;
      sawAny = true;
      continue;
    }
    const logs = Array.isArray(event.logs) ? (event.logs as TailLog[]) : [];
    // #3354: this invocation's own answer line, which carries its marks and the
    // Worker's invocation index; read once per invocation and paired with its profile.
    const answerText = logs.map((l) => messageText(l.message)).find((t) => t.includes(ANSWER_MSG)) ?? null;
    // #3354: one of the shared line object's traced calls, logged by the object itself.
    for (const entry of logs) {
      const text = messageText(entry.message);
      if (!text.includes(OBJECT_TAG) || !text.includes(OBJECT_MSG)) continue;
      const trace = textField(text, "trace");
      if (!trace) continue;
      const calls = objectCalls.get(trace) ?? [];
      calls.push({ stage: textField(text, "stage") ?? "unknown", op: textField(text, "op") ?? "unknown", wallMs: num(event.wallTime) });
      objectCalls.set(trace, calls);
    }
    for (const entry of logs) {
      const text = messageText(entry.message);
      if (!text.includes(TAG)) continue;
      sawAny = true;
      const startedAt = num(event.eventTimestamp);
      const loggedAt = num(entry.timestamp);
      const totalMs = field(text, "total_ms");
      const isolateAgeMs = field(text, "isolate_age_ms");
      if (startedAt === null || loggedAt === null || totalMs === null || isolateAgeMs === null) {
        // Every one of these is a reading this could not make. Dropping them would
        // leave a reader taking the remaining samples for the whole run.
        reading.unreadable += 1;
        continue;
      }
      const sinceInvocation = loggedAt - startedAt - totalMs;
      const preProfileMs = Math.max(0, sinceInvocation);
      if (sinceInvocation < 0) reading.impossible += 1;
      // The isolate became ready INSIDE this request exactly when the module is no
      // older than the time since the invocation began. That is a measurement, not
      // a threshold somebody picked off a histogram (L203): every other way of
      // saying "this one was cold" is an inference from the distribution being
      // bimodal, which is the very thing the split is meant to explain.
      const cold = isolateAgeMs <= preProfileMs;
      reading.samples += 1;
      reading.handlerMs.push(totalMs);
      reading.preProfileMs.push(preProfileMs);
      // The runtime's own reading, kept only when the archive carried one: a
      // missing cpuTime is a shorter list, never a zero, because a zero would be
      // the cheapest possible confirm and pull every percentile down (L98).
      const cpuMs = num(event.cpuTime);
      // Everything the invocation did after this line was written. Never negative:
      // a wall shorter than the span to the log line is an archive that disagrees
      // with itself, and it is already counted as impossible below.
      const wallMs = num(event.wallTime);
      if (wallMs !== null) reading.afterProfileMs.push(Math.max(0, wallMs - (loggedAt - startedAt)));
      if (cold) {
        reading.cold += 1;
        reading.coldPreProfileMs.push(preProfileMs);
        if (cpuMs !== null) reading.coldCpuMs.push(cpuMs);
      } else {
        reading.warmPreProfileMs.push(preProfileMs);
        if (cpuMs !== null) reading.warmCpuMs.push(cpuMs);
      }
      const side = cold ? "cold" : "warm";
      const version = typeof event.scriptVersion?.id === "string" && event.scriptVersion.id ? event.scriptVersion.id : "unknown";
      const leg = (answerText !== null ? textField(answerText, "loadtest_leg") : null) || "none";
      (reading.byVersion[version] ??= { cold: [], warm: [] })[side].push(preProfileMs);
      (reading.byLeg[leg] ??= { cold: [], warm: [] })[side].push(preProfileMs);
      const lineTrace = answerText !== null ? textField(answerText, "line_trace") : null;
      if (lineTrace) {
        tracedConfirms.push({ side, trace: lineTrace, shared: textField(answerText ?? "", "line") === "shared", waitLineMs: field(answerText ?? "", "wait_line_ms") });
      }
      if (answerText !== null) {
        const invocationIndex = field(answerText, "isolate_invocation_index");
        const spans = reading.waitSpans[cold ? "cold" : "warm"];
        let marked = invocationIndex !== null;
        for (const name of WAIT_SPAN_FIELDS) {
          const v = field(answerText, name);
          if (v === null || v < 0) continue;
          (spans[name] ??= []).push(v);
          marked = true;
        }
        if (marked) {
          reading.markedSamples += 1;
          reading.markedBySide[cold ? "cold" : "warm"] += 1;
        }
        if (invocationIndex !== null && invocationIndex >= 0) {
          reading.invocationIndexKnown += 1;
          if (invocationIndex === 0) {
            reading.firstRequests += 1;
            if (!cold) reading.firstRequestsReadWarm += 1;
          }
        }
      }
    }
  }
  joinLineCalls(reading, tracedConfirms, objectCalls);
  return sawAny ? reading : null;
}

const OBJECT_TAG = `tag=${CONFIRM_LINE_TRACE_TAG}`;
const OBJECT_MSG = `msg="${TRACED_CALL_MSG}"`;

function emptySplit(): LineSplit {
  return { traced: 0, joined: 0, missing: 0, impossible: 0, unreadable: 0, heldMs: [], objectMs: [], outsideMs: [] };
}

/** #3354: each traced shared confirm's wait, split by the calls the object logged for it. */
function joinLineCalls(
  reading: ConfirmStartupReading,
  confirms: { side: "cold" | "warm"; trace: string; shared: boolean; waitLineMs: number | null }[],
  calls: Map<string, { stage: string; op: string; wallMs: number | null }[]>,
): void {
  const owned = new Set(confirms.map((c) => c.trace));
  for (const [trace, list] of calls) if (!owned.has(trace)) reading.lineSplit.orphanCalls += list.length;
  for (const c of confirms) {
    // Only the shared line calls the object, and a split needs the client's own span.
    if (!c.shared || c.waitLineMs === null || c.waitLineMs < 0) continue;
    const split = reading.lineSplit[c.side];
    split.traced += 1;
    const mine = calls.get(c.trace) ?? [];
    if (mine.length === 0) {
      split.missing += 1;
      continue;
    }
    const waiting = mine.filter((m) => m.stage === "wait");
    // A call with no readable wall time cannot be apportioned, so the split is not
    // made rather than made short (L98), and counted apart from a missing one (L11).
    if (waiting.some((m) => m.wallMs === null)) {
      split.unreadable += 1;
      continue;
    }
    const held = waiting.filter((m) => m.op === "poll").reduce((a, m) => a + (m.wallMs ?? 0), 0);
    const object = waiting.filter((m) => m.op !== "poll").reduce((a, m) => a + (m.wallMs ?? 0), 0);
    const outside = c.waitLineMs - held - object;
    if (outside < 0) {
      split.impossible += 1;
      continue;
    }
    split.joined += 1;
    split.heldMs.push(held);
    split.objectMs.push(object);
    split.outsideMs.push(outside);
  }
}

/**
 * What each DEFERRED job cost the invocation, by name (#2353).
 *
 * Run 34980777198 measured warm confirms at 2.8 to 3.4s of CPU on a 6.5s
 * invocation, of which about 3.5s was spent AFTER the response had gone. No lead
 * waits for that span and both Cloudflare's bill and the request CPU bar still
 * count it, so it is the span most worth apportioning. Until this it was ONE
 * number, inferred by subtracting the confirm's own log line from the
 * invocation's wall (`afterProfileMs` above), which cannot separate the webhook
 * send from the tally beside it.
 *
 * **WALL, not CPU, and no amount of instrumenting changes that.** `Date.now()` in
 * a Worker returns the time of the LAST I/O and does not advance during
 * execution, and Cloudflare provides no other timer, deliberately: it is the
 * Spectre mitigation the platform was designed around (the security model page),
 * and Workers tracing documents the same limitation as a non I/O span reporting
 * 0ms. So per stage CPU cannot be measured from inside a Worker at all, here or
 * anywhere else in this repo, and the only true CPU figure available is the
 * runtime's own ONE number per invocation (`cpuTime`, read above).
 *
 * NULL when the archive carries no deferred line at all, never an empty table: a
 * run whose archive never arrived and a run whose deferred work cost nothing
 * would otherwise render the same (L98).
 */
export interface DeferredSpanReading {
  /** How many times this job ran. */
  calls: number;
  /** Each run's own wall time, and SHORTER than `calls` where a line was unreadable. */
  ms: number[];
  /** Runs whose line carried no readable time, counted rather than scored zero (L50). */
  unreadable: number;
  /** Runs that ended in a failure, which cost the invocation their time all the same. */
  failed: number;
}

const DEFERRED_TAG = "tag=after-response-profile";

/** The `key=value` text of a field written by Slate's own formatter. */
function textField(line: string, key: string): string | null {
  const m = new RegExp(`(?:^|\\s)${key}=("[^"]*"|\\S+)`).exec(line);
  if (!m) return null;
  const raw = m[1]!;
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

export function readDeferredSpans(archive: string): Record<string, DeferredSpanReading> | null {
  const byContext: Record<string, DeferredSpanReading> = {};
  let sawAny = false;
  for (const raw of tailObjects(archive)) {
    let event: TailEvent;
    try {
      event = JSON.parse(raw) as TailEvent;
    } catch {
      // Counted by `readConfirmStartup`'s own `unparsable`, which reads the same
      // archive: counting it twice would report one truncated line as two faults.
      continue;
    }
    const logs = Array.isArray(event.logs) ? (event.logs as TailLog[]) : [];
    for (const entry of logs) {
      const text = messageText(entry.message);
      if (!text.includes(DEFERRED_TAG)) continue;
      sawAny = true;
      // An unnamed job is still a job. Dropping it would understate the span this
      // reading exists to apportion, and the name says which one to look at.
      const context = textField(text, "context") ?? "(unnamed)";
      const row = (byContext[context] ??= { calls: 0, ms: [], unreadable: 0, failed: 0 });
      row.calls += 1;
      if (textField(text, "failed") === "true") row.failed += 1;
      const ms = field(text, "ms");
      // A missing reading is a SHORTER list, never a zero: a zero is the cheapest
      // possible span and would pull every percentile down while looking like a
      // measurement (L50, and the same rule the CPU list above follows).
      if (ms === null) row.unreadable += 1;
      else row.ms.push(ms);
    }
  }
  return sawAny ? byContext : null;
}
