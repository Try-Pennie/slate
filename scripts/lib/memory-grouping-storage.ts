// The confirm line object's own storage, as a test holds it (#3479): a map that outlives
// any one object built over it, which is exactly what a hibernation is, so a test that
// builds a second object over the same storage is testing a woken instance. Values go in
// and come out through structuredClone, as the platform's storage serialises them.
import type { GroupingDirectoryStorage } from "../../src/lib/booking/pool-grouping.ts";

export function memoryGroupingStorage(): GroupingDirectoryStorage & { writes: number } {
  const kept = new Map<string, unknown>();
  const storage = {
    writes: 0,
    async get(key: string): Promise<unknown> {
      return structuredClone(kept.get(key));
    },
    async put(key: string, value: unknown): Promise<void> {
      storage.writes++;
      kept.set(key, structuredClone(value));
    },
  };
  return storage;
}
