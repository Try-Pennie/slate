import { getCloudflareContext } from "@opennextjs/cloudflare";
import { log } from "@/lib/log";
import { readWithinDeadline } from "@/lib/read-within-deadline";
import { CONFIRM_LINE_BINDING } from "@/lib/booking/confirm-line-object";
import { durableGroupingDirectory, type DurableLineNamespace } from "@/lib/booking/shared-confirm-line";
import { shortErrorReason } from "@/lib/notify/error-text";
import {
  POOL_GROUPING_DIRECTORY,
  POOL_GROUPING_PUBLISH_MS,
  groupingPutMessage,
  groupingSnapshotOf,
  type DirectoryStub,
  type GroupingEntry,
} from "@/lib/booking/pool-grouping";

/**
 * The pool grouping directory (#3460), wired to the deployment's `CONFIRM_LINE`
 * binding. The decisions (what a snapshot is, what is refused, what a server installs)
 * live in `pool-grouping.ts`, node tested; this is only where they meet the runtime.
 */

/**
 * The directory's stub, or null where there is none. Off the Workers runtime there is
 * no request context and no binding, which reads as unbound: a confirm there keys on
 * what its server holds, and a publish there is said as unbound rather than attempted.
 */
export function groupingDirectoryLive(name: string = POOL_GROUPING_DIRECTORY): DirectoryStub | null {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    const ns = env[CONFIRM_LINE_BINDING] as DurableLineNamespace | undefined;
    return ns ? durableGroupingDirectory(ns).directory(name) : null;
  } catch {
    return null;
  }
}

/**
 * How one publish ended. `ok` means the directory now holds a grouping at least this
 * fresh; only `stored` means it holds THIS one. `kept` is a newer snapshot already there,
 * which says the directory is fresh and nothing about this publisher's own read.
 */
export type PublishOutcome =
  | { ok: true; kind: "stored" | "kept" }
  | { ok: false; kind: "empty" | "unbound" | "unreachable" | "refused"; why?: string };

/**
 * Publish a grouping, read at `readAtMs` (when its read STARTED), to the directory.
 *
 * An EMPTY grouping is refused before anything is asked: a bucket read that came back
 * empty would otherwise publish a grouping in which every code is a gap, and every
 * ladder of one length alike (L215). Never throws: the recompute lane calls this in
 * its own step boundary and stamps its heartbeat only when the outcome is `stored`, so
 * a publisher that stops is paged (`POOL_GROUPING_STALE_BOUNDS_MS`) rather than failing
 * silently, and a stale one is never covered by somebody else's newer snapshot.
 */
export async function publishPoolGrouping(entries: readonly GroupingEntry[], readAtMs: number): Promise<PublishOutcome> {
  const failed = (out: Extract<PublishOutcome, { ok: false }>): PublishOutcome => {
    log.warn("pool-grouping", { msg: "pool grouping not published", kind: out.kind, why: out.why ?? null });
    return out;
  };
  if (entries.length === 0) return failed({ ok: false, kind: "empty", why: "the bucket list read empty" });
  const stub = groupingDirectoryLive();
  if (!stub) return failed({ ok: false, kind: "unbound" });
  let err: unknown = null;
  const answer = await readWithinDeadline(
    () => stub.send(groupingPutMessage(groupingSnapshotOf(entries, readAtMs))),
    POOL_GROUPING_PUBLISH_MS,
    (e) => (err = e),
  );
  if (!answer) return failed({ ok: false, kind: "unreachable", why: err ? shortErrorReason(err) : "no answer" });
  if (answer.kind === "stored" || answer.kind === "kept") {
    log.info("pool-grouping", { msg: "pool grouping published", outcome: answer.kind, count: entries.length, read_at_ms: readAtMs });
    return { ok: true, kind: answer.kind };
  }
  return failed({ ok: false, kind: "refused", why: typeof answer.why === "string" ? answer.why.slice(0, 80) : String(answer.kind) });
}
