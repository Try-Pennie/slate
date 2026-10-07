/**
 * The confirm line shared across isolates (#3325): one object per line group, a
 * line per instant inside it. One reserved instance is the pool grouping directory
 * instead (#3460), which holds the grouping a cold server keys its line from.
 *
 * Deliberately a shell, like `burst-limiter.ts`: every decision lives in
 * `@/lib/booking/confirm-line-object`, which the node tests drive. What is left here
 * is the request envelope, the role the call is served as (its path, and the
 * instance's own name when the runtime supplies one), the real clock and timers, and
 * the log a traced call is written to, which `scripts/test-confirm-line-binding.ts`
 * drives through this class. A line writes nothing to storage, so no input gate closes
 * on a line's instance and its held polls interleave at every await. The directory
 * DOES keep its snapshot in the instance's storage (#3479), because the platform
 * hibernates an idle object after ten seconds and discards its memory; that is only
 * ever its own instance, never a line's.
 */
import { makeConfirmLineObject, objectRoleOf, CONFIRM_LINE_TRACE_TAG, TRACED_CALL_MSG } from "@/lib/booking/confirm-line-object";
import type { GroupingDirectoryStorage } from "@/lib/booking/pool-grouping";
import { log } from "@/lib/log";

const realTimer = (ms: number, fire: () => void): (() => void) => {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
};

/**
 * The instance's own name, when the runtime supplies it. Whether `ctx.id.name` is set
 * inside an object named through `idFromName` is platform behaviour nothing here can
 * measure offline (L82), so an absent, unreadable or non string name is read as none
 * and the call's path alone decides its role.
 */
function instanceNameOf(ctx: unknown): string | undefined {
  try {
    const name = (ctx as { id?: { name?: unknown } } | undefined)?.id?.name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The instance's own storage (`ctx.storage`), where the directory keeps its snapshot
 * (#3479). With none on the context, a storage that refuses every call, so the directory
 * refuses its puts and the publisher is paged, rather than keeping the snapshot in memory
 * alone, which reads as healthy and is empty within a minute.
 */
function storageOf(ctx: unknown): GroupingDirectoryStorage {
  const storage = (ctx as { storage?: Partial<GroupingDirectoryStorage> } | undefined)?.storage;
  if (storage && typeof storage.get === "function" && typeof storage.put === "function") {
    const { get, put } = storage;
    return { get: (key) => get.call(storage, key), put: (key, value) => put.call(storage, key, value) };
  }
  const none = () => Promise.reject(new Error("this instance has no storage"));
  return { get: none, put: none };
}

export class ConfirmLine {
  private readonly name: string | undefined;
  private readonly object: ReturnType<typeof makeConfirmLineObject>;

  constructor(ctx?: unknown) {
    this.name = instanceNameOf(ctx);
    this.object = makeConfirmLineObject({
      now: () => Date.now(),
      timer: realTimer,
      leaseTimer: realTimer,
      newId: () => crypto.randomUUID(),
      // #3354: a traced call (sent by the load test's client only) is logged, so the
      // run can join this object's side of a confirm to the confirm's own line.
      onTrace: (call) => log.info(CONFIRM_LINE_TRACE_TAG, { msg: TRACED_CALL_MSG, ...call }),
      directoryStorage: storageOf(ctx),
    });
  }

  async fetch(request: Request): Promise<Response> {
    let message: unknown = null;
    try {
      message = await request.json();
    } catch {
      // An unreadable body is answered as a malformed message by the host, by name.
      message = null;
    }
    const role = objectRoleOf(new URL(request.url).pathname, this.name);
    const answer = await this.object.handle("role" in role ? role.role : role, message);
    return new Response(answer, { headers: { "content-type": "application/json" } });
  }
}
