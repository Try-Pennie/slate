/**
 * Where a booking confirm's wait before its profile went, as spans between marks
 * taken at fixed points of ONE request (#3354).
 *
 * Final run 1 (run 37390071571) failed only its confirm startup bar: the wait from
 * an invocation starting to the confirm's profile starting, on a fresh isolate. That
 * wait was one number, and the first attempt to split it subtracted the confirm
 * line's `line_ms`, which also counts calls made after the profile started and
 * leaves out the switch read, so the "rest" lay on both sides of the boundary (L699).
 * So each point is stamped where it happens and every span comes from the marks of
 * one request, logged on that request's own `confirm answered` line (L420).
 *
 * The points, in the order a direct booking API confirm passes them:
 *   entry       the Worker's fetch handler, before Next is reached (worker/index.ts)
 *   handler     the booking route's POST handler starting
 *   authed      the key, address and hourly ceilings answered
 *   line_start  the confirm's first call into its line (a lookahead or an enter)
 *   line_turn   the line handing the confirm its turn, or answering it outright
 *   decided     the person decision made, as leader
 *   profile     the confirm's profile starting (`makeConfirmProfile`)
 *
 * A Worker's clock moves at I/O, so each mark reads the time of the last I/O to
 * finish before it, and CPU spent after that I/O lands in the NEXT span. A span is
 * therefore waiting plus whatever computing followed the wait, never CPU alone.
 *
 * A point that was never marked is NAMED in `wait_missing` and its spans are absent
 * rather than zero (L90). The first mark of a point wins, and a point marked again
 * is counted in `wait_repeats`, so a second line entry cannot stretch the first
 * one's span. A point stamped earlier than the point before it is named in
 * `wait_out_of_order` and the span across it is withheld rather than reported
 * negative.
 */

/**
 * The Worker's two facts, carried to the route on the request because the Worker
 * runs before Next: when its fetch handler was entered, and how many times this
 * isolate had run the app before this request, counting HTTP requests, cron ticks
 * and log shipping receipts alike (`worker/app-invocations.ts`). An invocation index
 * of 0 is the isolate's first run of the app, counted at the Worker, independently
 * of when any module of the app was evaluated (#3354: the old cold test compares a
 * module scope stamp, which moves with the bundle, against the wait).
 */
export const ENTRY_AT_HEADER = "x-slate-entry-at-ms";
export const INVOCATION_INDEX_HEADER = "x-slate-isolate-invocation-index";

/**
 * The request the app should see. Under the load test the Worker's own stamp and
 * count replace any a caller sent; otherwise the request passes through untouched.
 */
export function withEntryMarks(request: Request, at: { loadtest: boolean; nowMs: number; invocationIndex: number }): Request {
  if (!at.loadtest) return request;
  const headers = new Headers(request.headers);
  headers.set(ENTRY_AT_HEADER, String(at.nowMs));
  headers.set(INVOCATION_INDEX_HEADER, String(at.invocationIndex));
  return new Request(request, { headers });
}

/** The Worker's stamp and count as the route reads them; anything unreadable is null. */
export function readEntryMarks(headers: Headers): { entryAtMs: number | null; invocationIndex: number | null } {
  const whole = (raw: string | null): number | null => {
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  };
  return { entryAtMs: whole(headers.get(ENTRY_AT_HEADER)), invocationIndex: whole(headers.get(INVOCATION_INDEX_HEADER)) };
}

export const WAIT_POINTS = ["entry", "handler", "authed", "line_start", "line_turn", "decided", "profile"] as const;
export type WaitPoint = (typeof WAIT_POINTS)[number];

/** The span named for the point it ENDS at, from the point before it. */
const SPAN_ENDING_AT: Record<Exclude<WaitPoint, "entry">, string> = {
  handler: "wait_route_ms",
  authed: "wait_auth_ms",
  line_start: "wait_pre_line_ms",
  line_turn: "wait_line_ms",
  decided: "wait_decide_ms",
  profile: "wait_to_profile_ms",
};

export interface WaitMarks {
  /** Stamp a point now. The first stamp of a point wins; later ones are counted. */
  mark(point: WaitPoint): void;
  /** The spans, the whole, and what was missing, repeated or out of order. */
  fields(): Record<string, number | string>;
}

/**
 * `entryAtMs` is the Worker entry's stamp, handed in by the route because the
 * Worker runs before the route exists; null or undefined when it was not given.
 */
export function makeWaitMarks(now: () => number, entryAtMs: number | null | undefined): WaitMarks {
  const at = new Map<WaitPoint, number>();
  const times = new Map<WaitPoint, number>();
  if (typeof entryAtMs === "number" && Number.isFinite(entryAtMs)) {
    at.set("entry", entryAtMs);
    times.set("entry", 1);
  }
  return {
    mark(point) {
      times.set(point, (times.get(point) ?? 0) + 1);
      if (!at.has(point)) at.set(point, now());
    },
    fields() {
      const out: Record<string, number | string> = {};
      const missing: string[] = [];
      const outOfOrder: string[] = [];
      let lastSeen: number | null = null;
      for (let i = 0; i < WAIT_POINTS.length; i++) {
        const point = WAIT_POINTS[i]!;
        const t = at.get(point);
        if (t === undefined) {
          missing.push(point);
          continue;
        }
        if (lastSeen !== null && t < lastSeen) outOfOrder.push(point);
        else lastSeen = t;
        if (i === 0) continue;
        const prev = at.get(WAIT_POINTS[i - 1]!);
        const name = SPAN_ENDING_AT[point as Exclude<WaitPoint, "entry">];
        if (prev !== undefined && t >= prev && !outOfOrder.includes(point)) out[name] = t - prev;
      }
      const first = WAIT_POINTS.map((p) => at.get(p)).find((t) => t !== undefined);
      const end = at.get("profile");
      if (first !== undefined && end !== undefined && end >= first) out.wait_total_ms = end - first;
      if (missing.length > 0) out.wait_missing = missing.join(",");
      if (outOfOrder.length > 0) out.wait_out_of_order = outOfOrder.join(",");
      const repeats = WAIT_POINTS.filter((p) => (times.get(p) ?? 0) > 1).map((p) => `${p}:${times.get(p)}`);
      if (repeats.length > 0) out.wait_repeats = repeats.join(",");
      return out;
    },
  };
}
