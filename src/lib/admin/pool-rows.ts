/**
 * Collapsing a screen's sixty rows into the fifteen answers they carry (#2237).
 *
 * The tiers page and the supply page each list one row per bucket CODE, and the
 * six codes in a tier produce identical numbers by construction: they share one
 * set of criteria, so they resolve the same agents and the same slots. Sixty
 * rows giving fifteen answers is what a reader has to hold in their head before
 * they can compare anything, and it gives the duplication the same visual weight
 * as the differences (L605, L609).
 *
 * Grouping is a DISPLAY convenience. Being right is not, which is why a group
 * whose rows disagree is not collapsed at all: showing one row's number under a
 * heading that covers six would drop five readings on a screen whose whole job is
 * to report them (L131). That cannot happen while the pool key covers everything
 * the numbers are derived from, and it is guarded precisely because the day it
 * can, nothing else would notice.
 */

export interface PoolRowInput {
  code: string;
  poolKey: string;
  poolLabel: string | null;
}

export interface PoolGroup<T> {
  key: string;
  label: string | null;
  /** Every code in the group, in code order. */
  codes: string[];
  /** The rows themselves, so a caller can render one and still reach the rest. */
  rows: T[];
  /** Whether every row in the group agreed. A false here means the group was
   *  SPLIT rather than collapsed, and the caller should say so. */
  uniform: boolean;
}

/**
 * Group rows by their pool, collapsing only where every row agrees.
 *
 * `same` is the caller's own idea of agreement, because each screen shows
 * different numbers and only the screen knows which of them the reader would
 * notice losing.
 *
 * Groups come back in the order their first row appeared, so the page's own
 * ordering survives; the codes INSIDE a group are sorted, because the order rows
 * arrive in is the store's and means nothing to a reader (L343).
 */
export function groupRowsByPool<T extends PoolRowInput>(
  rows: T[],
  same: (a: T, b: T) => boolean,
): PoolGroup<T>[] {
  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    const group = byKey.get(r.poolKey);
    if (group) group.push(r);
    else {
      byKey.set(r.poolKey, [r]);
      order.push(r.poolKey);
    }
  }

  const out: PoolGroup<T>[] = [];
  for (const key of order) {
    const members = byKey.get(key)!;
    const first = members[0]!;
    const uniform = members.every((m) => same(first, m));
    if (uniform) {
      out.push({
        key,
        label: first.poolLabel,
        codes: members.map((m) => m.code).sort(),
        rows: members,
        uniform: true,
      });
      continue;
    }
    // Split, one group per row, each marked non-uniform so the screen can say
    // why these are not sitting together.
    for (const m of members) {
      out.push({ key, label: m.poolLabel, codes: [m.code], rows: [m], uniform: false });
    }
  }
  return out;
}
