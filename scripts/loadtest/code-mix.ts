/**
 * The bucket codes a load run books against, weighted by the traffic cal.com
 * actually took (#2243).
 *
 * MEASURED, not invented: these are the routed routing form responses across the
 * 30 days to 2026-09-11, counted per code by `pnpm verify:router-replay` (#2240).
 * An even spread across sixty codes would be a different test entirely. Real
 * traffic is enormously lopsided (112 alone is 31 percent of it, and the whole
 * Beyond family together is under 1.5 percent), and the lopsidedness is the load:
 * the hot codes are the ones whose pools are largest and whose slot cache is
 * contended, and the cold ones are where a single agent pool makes every second
 * booking a conflict.
 *
 * Pure, so `scripts/test-loadtest-code-mix.ts` drives the weighting with no
 * randomness and no network.
 */

/** One code and the number of routed leads it carried in the measured window. */
export interface CodeWeight {
  code: string;
  leads: number;
}

/** Routed leads per code, 2026-08-12 to 2026-09-11, 25,735 in total. */
export const MEASURED_CODE_MIX: readonly CodeWeight[] = [
  { code: "112", leads: 7909 },
  { code: "212", leads: 5898 },
  { code: "111", leads: 2546 },
  { code: "312", leads: 2490 },
  { code: "211", leads: 1744 },
  { code: "412", leads: 1665 },
  { code: "512", leads: 1193 },
  { code: "311", leads: 705 },
  { code: "411", leads: 488 },
  { code: "511", leads: 376 },
  { code: "100", leads: 296 },
  { code: "222", leads: 90 },
  { code: "131", leads: 65 },
  { code: "122", leads: 51 },
  { code: "322", leads: 42 },
  { code: "231", leads: 39 },
  { code: "522", leads: 26 },
  { code: "221", leads: 19 },
  { code: "422", leads: 17 },
  { code: "121", leads: 15 },
  { code: "331", leads: 15 },
  { code: "431", leads: 11 },
  { code: "132", leads: 8 },
  { code: "531", leads: 8 },
  { code: "232", leads: 7 },
  { code: "321", leads: 6 },
  { code: "332", leads: 4 },
  { code: "421", leads: 2 },
  { code: "432", leads: 1 },
];

/**
 * The code for the n-th request of a driver, in the measured proportions.
 *
 * DETERMINISTIC over `(driver, n)` rather than random, for the reason the fault
 * injector is: a run that passed and a run that failed must differ by the code,
 * not by the dice. It is the SLOT that is picked at random (#2243), because that
 * is where contention between drivers has to be genuine.
 *
 * The sequence is built by largest remainder over a cycle, then walked, so the
 * proportions hold over any whole cycle and every code appears in one.
 */
export function codeSequence(total: number, mix: readonly CodeWeight[] = MEASURED_CODE_MIX): string[] {
  if (total <= 0) return [];
  const sum = mix.reduce((s, m) => s + m.leads, 0);
  if (sum <= 0) return [];
  const exact = mix.map((m) => (m.leads / sum) * total);
  const counts = exact.map((n) => Math.floor(n));
  let left = total - counts.reduce((s, n) => s + n, 0);
  const order = exact
    .map((n, i) => ({ i, frac: n - Math.floor(n), leads: mix[i]!.leads }))
    .sort((a, b) => b.frac - a.frac || b.leads - a.leads || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    counts[o.i]!++;
    left--;
  }
  // Interleaved rather than blocked, so any PREFIX of the sequence is
  // representative. Blocked would have a driver spend its first minutes entirely
  // on 112, and a run cut short (or judged minute by minute) would be measuring
  // one pool.
  const out: string[] = [];
  const remaining = [...counts];
  while (out.length < total) {
    let placed = false;
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i]! > 0 && out.length < total) {
        out.push(mix[i]!.code);
        remaining[i]!--;
        placed = true;
      }
    }
    if (!placed) break;
  }
  return out;
}

/**
 * There is deliberately no BURST_CODE constant here any more (#2278).
 *
 * It named the pool the burst fires at, the whole burst control rests on that pool
 * being ONE agent deep, and nothing measured it: the seeded roster gave it three,
 * so a live run answered three 200s on three different agents, which is correct
 * behaviour and a materially weaker control than the one intended. It rotted as
 * well, and did: production's Low plus Beyond pool emptied when Twilio became the
 * attribute source (#2152) and the constant had to be moved by hand from 122 to
 * 222 on the morning of the next run (#2319).
 *
 * `scripts/loadtest/burst-setup.ts` measures the roster through the booker's own
 * predicates and, since #3429, chooses each burst by what its whole LADDER holds: the
 * refusal control at the smallest ladder under its crowd, the tier drop burst at the
 * shallowest top rung with room below. What it measured travels in the burst plan to
 * the report. There is no hand override: a burst sized without the measurement is the
 * unmeasured control this removed.
 */
