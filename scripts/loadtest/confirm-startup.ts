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

/**
 * The wait before the profile, cold and warm, for one script version or one leg, and
 * the confirms that carried no invocation index and so are on neither side (#3418),
 * kept so a group's total is never short in silence.
 */
export interface SideWaits {
  cold: number[];
  warm: number[];
  unknown: number[];
}

/** What one archived run says about the confirms in it. */
export interface ConfirmStartupReading {
  /** How many confirm profiles were read in full. */
  samples: number;
  /**
   * How many of those were their isolate's FIRST request: the Worker counted no earlier
   * run of the app on that isolate (`isolate_invocation_index=0` on the confirm's own
   * answer line, `worker/app-invocations.ts`). This is the cold population, and every
   * cold list below is filed by it (#3418).
   *
   * It used to be the module stamp's call (the confirm module evaluated inside this
   * request), which also counts the first CONFIRM on an isolate that had already run the
   * app for something else: that request loads the confirm's code without the isolate
   * starting. Run 37520312761 counted 8 cold by the stamp and 4 by the Worker. The four
   * the Worker counted 1, 1, 2 and 1 had no gap at all between the invocation starting
   * and the Worker's handler being entered, while the four it counted 0 waited 585 to
   * 1,021ms there, which is the isolate starting; across the run's 518 confirms counted
   * above 0 that gap was never over 2ms. The startup bar judges a lead landing on an
   * isolate that is starting, so it is judged on this count.
   */
  cold: number;
  /** Confirms the Worker counted as a later request on an isolate already running. */
  warm: number;
  /**
   * Confirms whose invocation carried no readable invocation index: an answer line
   * missing or unreadable, or a deployment older than #3354. On NEITHER side rather than
   * filed by the module stamp, because filing them by a second definition would put two
   * meanings into one population (L93). `samples` is always `cold + warm + indexUnknown`.
   */
  indexUnknown: number;
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
  /**
   * #3436: the isolate's own start, from the invocation beginning (the event's
   * `eventTimestamp`) to the Worker's fetch handler being entered (the entry stamp the
   * answer line carries as `wait_entry_at_ms`), filed cold and warm like the spans.
   *
   * Every span above starts AT the entry, so this was in none of them, and on run
   * 37520312761 it was the biggest single piece of the startup bar's miss: the four first
   * requests waited 585, 611, 638 and 1,021ms there, against 0 to 2ms on every confirm
   * counted above 0. Measured from its own two ends, never as the wait less the marks'
   * whole span (L699).
   *
   * Read only from a confirm carrying both stamps. One with no readable entry stamp is
   * counted in `unstamped` on its side, never read as zero, which would be the fastest
   * start there is (L622); one whose event carried no `eventTimestamp` was never a sample
   * and is in `unreadable`. A stamp earlier than the invocation's start is two clocks
   * disagreeing, counted in `beforeStart` rather than read as a negative or clamped. A
   * confirm on neither side is in `indexUnknown` and nowhere here.
   */
  isolateStart: {
    cold: number[];
    warm: number[];
    unstamped: { cold: number; warm: number };
    beforeStart: { cold: number; warm: number };
  };
  /** Profiles whose invocation logged a `confirm answered` line with marks or an invocation index. */
  markedSamples: number;
  /** The same, split by the cold or warm call, so each side says how many carried marks. */
  markedBySide: { cold: number; warm: number };
  /**
   * #3418: where the module stamp disagrees with the Worker's count, named rather than
   * printed as a second count of the same thing. The stamp reads the confirm's code as
   * evaluated inside the request when the module is no older than the time since the
   * invocation began.
   *
   * `stampColdNotFirst`: the stamp read the code as loaded inside the request on an
   * isolate the Worker had already run the app on. The first confirm on that isolate,
   * counted warm, because the isolate did not start for it (4 in run 37520312761).
   *
   * `stampWarmFirst`: a first request whose code the stamp read as already loaded. It is
   * cold whatever the stamp read, since nothing ran on that isolate before it; the count
   * says the stamp disagreed, which a reader of the stamp's own figures needs to know.
   */
  stampColdNotFirst: number;
  stampWarmFirst: number;
  /** #3354: the shared line's wait, split by the object's own log, cold and warm. */
  lineSplit: { cold: LineSplit; warm: LineSplit; orphanCalls: number };
  /** #3354: the wait before the profile by the Worker version that served it (`unknown` when the event named none). */
  byVersion: Record<string, SideWaits>;
  /** #3354: and by the load run leg that sent it (`none` when it named none). */
  byLeg: Record<string, SideWaits>;
  /**
   * Profiles left out because they were sent by another leg than the one asked for,
   * so a reading scoped to one leg says how much of its archive it set aside (L629).
   * Always 0 for a reading of the whole archive.
   */
  otherLegs: number;
}

/** The spans `wait-marks.ts` writes, in the order a confirm passes them. */
export { WAIT_SPAN_FIELDS } from "../../src/lib/booking/wait-marks.ts";
import { ENTRY_STAMP_FIELD, WAIT_SPAN_FIELDS, type LoadtestLeg } from "../../src/lib/booking/wait-marks.ts";

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
  /** #3416: the request that started it, as the runtime archives it. */
  event?: { request?: { headers?: Record<string, unknown> | null } | null } | null;
}

/** One log line of one invocation, as text, with the Worker's clock when it was written. */
export interface TailLogLine {
  text: string;
  timestamp: number | null;
}

/**
 * One invocation of the archive and every line it logged (#3416).
 *
 * The ONE way the archive is read into requests: a confirm's answer line, its profile
 * line and its marks are paired by being in the same invocation (L420), and the
 * startup reading and the burst breakdown both read through this rather than each
 * parsing events of its own.
 */
export interface TailInvocation {
  /** The invocation's start, on the Worker's clock. */
  eventTimestamp: number | null;
  cpuTime: number | null;
  wallTime: number | null;
  /** The Worker version that served it, or null when the event named none. */
  scriptVersion: string | null;
  /**
   * The address the request came from (`cf-connecting-ip`), which is what the
   * deployment echoes to a load run as the address it saw. Null for a cron tick, a
   * Durable Object call, or an event that carried no request headers.
   */
  requestIp: string | null;
  logs: TailLogLine[];
}

/** One object out of the archive: an invocation, or a stretch that is not readable JSON. */
export type TailItem = { kind: "invocation"; invocation: TailInvocation } | { kind: "unparsable" };

/** Every invocation in an archived `wrangler tail --format json` file, in order. */
export function* tailInvocations(archive: string): Generator<TailItem> {
  for (const raw of tailObjects(archive)) {
    let event: TailEvent;
    try {
      event = JSON.parse(raw) as TailEvent;
    } catch {
      yield { kind: "unparsable" };
      continue;
    }
    const logs = Array.isArray(event.logs) ? (event.logs as TailLog[]) : [];
    const ip = event.event?.request?.headers?.["cf-connecting-ip"];
    yield {
      kind: "invocation",
      invocation: {
        eventTimestamp: num(event.eventTimestamp),
        cpuTime: num(event.cpuTime),
        wallTime: num(event.wallTime),
        scriptVersion: typeof event.scriptVersion?.id === "string" && event.scriptVersion.id ? event.scriptVersion.id : null,
        requestIp: typeof ip === "string" && ip !== "" ? ip : null,
        logs: logs.map((l) => ({ text: messageText(l.message), timestamp: num(l.timestamp) })),
      },
    };
  }
}

/** The invocation's own `confirm answered` line, or null when it wrote none. */
export function answerLineOf(inv: TailInvocation): TailLogLine | null {
  return inv.logs.find((l) => l.text.includes(ANSWER_MSG)) ?? null;
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

/** A `key=value` field out of a line Slate's own formatter wrote. Exported as `logNumber`. */
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
export function readConfirmStartup(archive: string, opts?: { leg?: LoadtestLeg }): ConfirmStartupReading | null {
  const reading: ConfirmStartupReading = {
    samples: 0,
    cold: 0,
    warm: 0,
    indexUnknown: 0,
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
    isolateStart: { cold: [], warm: [], unstamped: { cold: 0, warm: 0 }, beforeStart: { cold: 0, warm: 0 } },
    markedSamples: 0,
    markedBySide: { cold: 0, warm: 0 },
    stampColdNotFirst: 0,
    stampWarmFirst: 0,
    lineSplit: { cold: emptySplit(), warm: emptySplit(), orphanCalls: 0 },
    byVersion: {},
    byLeg: {},
    otherLegs: 0,
  };
  let sawAny = false;
  // #3354: the object's traced calls by trace, and the confirms that may own them,
  // joined once the whole archive is read (an object's calls usually arrive first).
  const objectCalls = new Map<string, { stage: string; op: string; wallMs: number | null }[]>();
  const tracedConfirms: { side: Side | null; trace: string; shared: boolean; waitLineMs: number | null }[] = [];
  // The traces of confirms a scoped reading left out, so their object calls are left
  // out with them rather than counted as orphans of a confirm the archive does hold.
  const otherLegTraces = new Set<string>();

  for (const item of tailInvocations(archive)) {
    if (item.kind === "unparsable") {
      // Counted rather than skipped. A truncated line is a reading this could not
      // make, and one dropped in silence leaves a reader taking the samples it did
      // read for the whole run (L10, L11).
      reading.unparsable += 1;
      sawAny = true;
      continue;
    }
    const inv = item.invocation;
    // #3354: this invocation's own answer line, which carries its marks and the
    // Worker's invocation index; read once per invocation and paired with its profile.
    const answerText = answerLineOf(inv)?.text ?? null;
    // #3354: one of the shared line object's traced calls, logged by the object itself.
    for (const entry of inv.logs) {
      const text = entry.text;
      if (!text.includes(OBJECT_TAG) || !text.includes(OBJECT_MSG)) continue;
      const trace = textField(text, "trace");
      if (!trace) continue;
      const calls = objectCalls.get(trace) ?? [];
      calls.push({ stage: textField(text, "stage") ?? "unknown", op: textField(text, "op") ?? "unknown", wallMs: inv.wallTime });
      objectCalls.set(trace, calls);
    }
    for (const entry of inv.logs) {
      const text = entry.text;
      if (!text.includes(TAG)) continue;
      sawAny = true;
      // The leg that sent it, from the same invocation's answer line. A reading scoped
      // to one leg sets every other profile aside BEFORE anything is counted, so each
      // figure it reports (the first requests, the spans, the versions) describes one
      // population rather than the waits alone (L629).
      const leg = (answerText !== null ? textField(answerText, "loadtest_leg") : null) || "none";
      if (opts?.leg !== undefined && leg !== opts.leg) {
        reading.otherLegs += 1;
        const trace = answerText !== null ? textField(answerText, "line_trace") : null;
        if (trace) otherLegTraces.add(trace);
        continue;
      }
      const startedAt = inv.eventTimestamp;
      const loggedAt = entry.timestamp;
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
      // #3418: cold is the Worker's own count, read from this invocation's answer line:
      // no earlier run of the app on this isolate means this request started it. A
      // measurement, not a threshold somebody picked off a histogram (L203). With no
      // readable count the confirm is on neither side, never filed by another rule.
      const invocationIndex = sideIndex(answerText);
      const side: Side | null = invocationIndex === null ? null : invocationIndex === 0 ? "cold" : "warm";
      // The module stamp: the confirm's code was evaluated inside this request when the
      // module is no older than the time since the invocation began. It decides nothing
      // any more; it names where it and the Worker disagree (see the reading's fields).
      const stampCold = isolateAgeMs <= preProfileMs;
      if (side === "warm" && stampCold) reading.stampColdNotFirst += 1;
      if (side === "cold" && !stampCold) reading.stampWarmFirst += 1;
      reading.samples += 1;
      reading.handlerMs.push(totalMs);
      reading.preProfileMs.push(preProfileMs);
      // The runtime's own reading, kept only when the archive carried one: a
      // missing cpuTime is a shorter list, never a zero, because a zero would be
      // the cheapest possible confirm and pull every percentile down (L98).
      const cpuMs = inv.cpuTime;
      // Everything the invocation did after this line was written. Never negative:
      // a wall shorter than the span to the log line is an archive that disagrees
      // with itself, and it is already counted as impossible below.
      const wallMs = inv.wallTime;
      if (wallMs !== null) reading.afterProfileMs.push(Math.max(0, wallMs - (loggedAt - startedAt)));
      if (side === "cold") {
        reading.cold += 1;
        reading.coldPreProfileMs.push(preProfileMs);
        if (cpuMs !== null) reading.coldCpuMs.push(cpuMs);
      } else if (side === "warm") {
        reading.warm += 1;
        reading.warmPreProfileMs.push(preProfileMs);
        if (cpuMs !== null) reading.warmCpuMs.push(cpuMs);
      } else {
        reading.indexUnknown += 1;
      }
      // Filed under its version and leg on whichever side it is, or on neither, so a
      // group's total is every confirm in it (L629).
      const group = side ?? "unknown";
      const version = inv.scriptVersion ?? "unknown";
      (reading.byVersion[version] ??= { cold: [], warm: [], unknown: [] })[group].push(preProfileMs);
      (reading.byLeg[leg] ??= { cold: [], warm: [], unknown: [] })[group].push(preProfileMs);
      // #3436: the isolate's own start, from this invocation's start to the Worker's
      // entry stamp on its own answer line. `startedAt` is known to be there (a confirm
      // without it is unreadable above), so only the entry stamp can be missing.
      if (side !== null) {
        const entryAt = answerText !== null ? field(answerText, ENTRY_STAMP_FIELD) : null;
        if (entryAt === null) reading.isolateStart.unstamped[side] += 1;
        else if (entryAt < startedAt) reading.isolateStart.beforeStart[side] += 1;
        else reading.isolateStart[side].push(entryAt - startedAt);
      }
      const lineTrace = answerText !== null ? textField(answerText, "line_trace") : null;
      if (lineTrace) {
        tracedConfirms.push({ side, trace: lineTrace, shared: textField(answerText ?? "", "line") === "shared", waitLineMs: field(answerText ?? "", "wait_line_ms") });
      }
      if (answerText !== null) {
        let marked = field(answerText, "isolate_invocation_index") !== null;
        for (const name of WAIT_SPAN_FIELDS) {
          const v = field(answerText, name);
          if (v === null || v < 0) continue;
          // A span is filed on the confirm's side; one on neither side has no list to
          // join, and is still counted as marked below.
          if (side !== null) (reading.waitSpans[side][name] ??= []).push(v);
          marked = true;
        }
        if (marked) {
          reading.markedSamples += 1;
          if (side !== null) reading.markedBySide[side] += 1;
        }
      }
    }
  }
  for (const trace of otherLegTraces) objectCalls.delete(trace);
  joinLineCalls(reading, tracedConfirms, objectCalls);
  return sawAny ? reading : null;
}

const OBJECT_TAG = `tag=${CONFIRM_LINE_TRACE_TAG}`;
const OBJECT_MSG = `msg="${TRACED_CALL_MSG}"`;

/** Which side of the startup split a confirm is on. */
type Side = "cold" | "warm";

/**
 * #3418: the Worker's count of this isolate's earlier runs of the app, from the
 * invocation's own answer line, or null when the line is absent or the count is not a
 * whole number of zero or more (`readEntryMarks` writes nothing else, so anything else
 * is a line this cannot trust, L50).
 */
function sideIndex(answerText: string | null): number | null {
  if (answerText === null) return null;
  const n = field(answerText, "isolate_invocation_index");
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function emptySplit(): LineSplit {
  return { traced: 0, joined: 0, missing: 0, impossible: 0, unreadable: 0, heldMs: [], objectMs: [], outsideMs: [] };
}

/** #3354: each traced shared confirm's wait, split by the calls the object logged for it. */
function joinLineCalls(
  reading: ConfirmStartupReading,
  confirms: { side: Side | null; trace: string; shared: boolean; waitLineMs: number | null }[],
  calls: Map<string, { stage: string; op: string; wallMs: number | null }[]>,
): void {
  // Every confirm in the archive owns its calls, including one on neither side (#3418),
  // so a missing invocation index never turns its calls into orphans.
  const owned = new Set(confirms.map((c) => c.trace));
  for (const [trace, list] of calls) if (!owned.has(trace)) reading.lineSplit.orphanCalls += list.length;
  for (const c of confirms) {
    // Only the shared line calls the object, and a split needs the client's own span
    // and a side to be filed on; a confirm on neither side is counted in `indexUnknown`.
    if (c.side === null || !c.shared || c.waitLineMs === null || c.waitLineMs < 0) continue;
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

/** The `key=value` text of a field written by Slate's own formatter. Exported as `logText`. */
function textField(line: string, key: string): string | null {
  const m = new RegExp(`(?:^|\\s)${key}=("[^"]*"|\\S+)`).exec(line);
  if (!m) return null;
  const raw = m[1]!;
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

/**
 * #3416: the field readers, exported so every reader of the archive reads a field the
 * one way (L41): a number through the same finite guard, a text with its quotes off.
 */
export { field as logNumber, textField as logText };

export function readDeferredSpans(archive: string): Record<string, DeferredSpanReading> | null {
  const byContext: Record<string, DeferredSpanReading> = {};
  let sawAny = false;
  for (const item of tailInvocations(archive)) {
    // An unparsable stretch is counted by `readConfirmStartup`'s own `unparsable`,
    // which reads the same archive: counting it twice would report one truncated
    // line as two faults.
    if (item.kind === "unparsable") continue;
    for (const entry of item.invocation.logs) {
      const text = entry.text;
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
