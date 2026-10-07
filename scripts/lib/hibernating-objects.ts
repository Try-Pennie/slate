// Durable Objects as the platform runs them between calls, for a test (#3481): an instance
// left idle for the hibernation window is discarded, and the next call reaches a NEW
// instance built over the SAME storage, which is what a woken object is. Within the window
// a call reaches the instance already in memory.
//
// The platform counts idleness from when the last call FINISHED ("after 10 seconds of no
// incoming request or event", the Durable Object lifecycle docs), so that is when this
// stamps it. A call that is still running keeps its instance awake, as on the platform.
//
// It imports nothing but types, so the node suites and the vitest route test share it
// without either reaching into the other's module setup.
import type { GroupingDirectoryStorage } from "../../src/lib/booking/pool-grouping.ts";
import { memoryGroupingStorage } from "./memory-grouping-storage.ts";

export interface HibernatingObjects<O> {
  /** Run one call on whichever instance of `name` it would reach now. */
  call<T>(name: string, work: (instance: O) => Promise<T>): Promise<T>;
  /** How many times `name` has been woken: built again after sleeping, the first build not counted. */
  wakes(name: string): number;
}

export function hibernatingObjects<O>(deps: {
  now: () => number;
  /** Build one instance over its storage. */
  build: (storage: GroupingDirectoryStorage) => O;
  /** How long an idle instance stays in memory. Infinity is a platform that never discards one. */
  idleMs: number;
  /**
   * The storage a woken instance is handed, given what the instance before it held. The
   * platform hands back the same storage; a defect can hand back something else.
   */
  storageOnWake?: (kept: GroupingDirectoryStorage) => GroupingDirectoryStorage;
}): HibernatingObjects<O> {
  const held = new Map<string, { instance: O; storage: GroupingDirectoryStorage; idleSince: number | null; running: number; wakes: number }>();
  return {
    async call(name, work) {
      let entry = held.get(name);
      if (!entry) {
        const storage = memoryGroupingStorage();
        entry = { instance: deps.build(storage), storage, idleSince: null, running: 0, wakes: 0 };
        held.set(name, entry);
      } else if (entry.running === 0 && entry.idleSince !== null && deps.now() - entry.idleSince >= deps.idleMs) {
        const storage = deps.storageOnWake ? deps.storageOnWake(entry.storage) : entry.storage;
        entry.storage = storage;
        entry.instance = deps.build(storage);
        entry.wakes++;
      }
      entry.running++;
      try {
        return await work(entry.instance);
      } finally {
        entry.running--;
        entry.idleSince = deps.now();
      }
    },
    wakes(name) {
      return held.get(name)?.wakes ?? 0;
    },
  };
}
