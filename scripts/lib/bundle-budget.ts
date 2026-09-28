// The client bundle budget the pre-push gate enforces (#2571, #2676).
//
// Pure decisions plus the one weigher, so scripts/test-prepush-bundle-budget.ts can
// drive every verdict without a build. The hook calls scripts/bundle-budget.ts,
// which is a thin CLI over this file. Node builtins only, and relative imports
// only, so it runs on bare node inside the isolated tree.
//
// WHY THE RECORD IS COMMITTED. The first version judged against a record in
// ~/.claude/state that moved only on an explicit acceptance, so each change that
// grew the bundle inside the margin left it behind, and the next change paid for
// all of them (on 2026-09-24 it sat 11 KB behind main). It was also per machine,
// and moved by pushes of branches that never merged. A record in the repo is read
// at the merge base for free, moves only when a reviewed change moves it, and is
// proved against a real build on every push, so it cannot quietly go stale.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** Where the record lives, relative to the repo root. The hook spells it too. */
export const BUNDLE_RECORD_PATH = ".githooks/bundle-budget.txt";

/** The client chunks the Worker serves, relative to a built tree. */
export const BUNDLE_CHUNKS_DIR = ".open-next/assets/_next/static/chunks";

/**
 * How far a build may sit from its record and still be the same bundle.
 *
 * Measured 2026-09-28: three from-scratch builds of f3f67791 (one with a server
 * only change) weighed 451,745 / 451,748 / 451,746, a 3 byte spread. 1 KB is
 * several hundred times that and a tenth of the growth margin, so drift that
 * several PRs each leave under the band is caught long before it can matter.
 */
export const NOISE_BAND_BYTES = 1024;

/** Growth over the merge base is refused only past BOTH of these, as the global guard does. */
export const MARGIN_PCT = 3;
export const MARGIN_ABS_BYTES = 10240;

const fmt = (n: number) => n.toLocaleString("en-US");

/** The record file's text for a total. The comment says how it moves. */
export function formatBundleRecord(total: number): string {
  return [
    "# The client bundle's gzipped weight, as the pre-push gate measures it (#2676).",
    "# Every push must carry the weight its own build measures, within 1 KB, so the change",
    "# that moves the bundle moves this line. The gate prints the command when it has to:",
    "#     pnpm bundle:record <total>",
    `total: ${total}`,
    "",
  ].join("\n");
}

/** The total a record carries, or null when it carries no single whole number (never zero). */
export function parseBundleRecord(text: string): number | null {
  const hits = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("total:"));
  if (hits.length !== 1) return null;
  const raw = hits[0].slice("total:".length).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export type Weighing =
  | { ok: true; total: number; chunks: number }
  | { ok: false; why: string };

/** Sum the level 9 gzipped size of every .js chunk under the tree's chunk directory. */
export function weighChunks(tree: string): Weighing {
  const dir = join(tree, BUNDLE_CHUNKS_DIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, why: `there is no ${BUNDLE_CHUNKS_DIR} in the built tree` };
  }
  let total = 0;
  let chunks = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".js")) {
        total += gzipSync(readFileSync(p), { level: 9 }).length;
        chunks++;
      }
    }
  };
  walk(dir);
  if (chunks === 0) return { ok: false, why: `${BUNDLE_CHUNKS_DIR} holds no .js chunks` };
  return { ok: true, total, chunks };
}

export type BundleVerdictKind =
  | "no-record"
  | "record-unreadable"
  | "record-behind-build"
  | "record-ahead-of-build"
  | "no-merge-base"
  | "no-base-record"
  | "grew-past-margin"
  | "accepted-growth"
  | "within-margin"
  | "unchanged"
  | "shrank";

export type BundleVerdict = { kind: BundleVerdictKind; refuse: boolean; lines: string[] };

export type BundleJudgeInput = {
  /** What the pushed commit's build weighs. */
  measured: number;
  /** The total the pushed commit's record carries, or null. */
  committed: number | null;
  /** Whether the pushed commit HAS a record file (so null means unreadable, not absent). */
  committedReadable: boolean;
  /** The total recorded at the merge base with main, or null. */
  base: number | null;
  /** The merge base commit, or null when it could not be found. */
  baseSha: string | null;
  /** ACCEPT_BUNDLE_GROWTH=1. */
  accept: boolean;
};

function rerecord(measured: number): string[] {
  return [
    "Re-record it, commit the file, and push again:",
    `    pnpm bundle:record ${measured}`,
    `    git add ${BUNDLE_RECORD_PATH} && git commit -m "Record the client bundle weight"`,
  ];
}

/**
 * The whole rule. The record check comes FIRST and nothing overrides it but a
 * skip: a push whose record does not carry its own build would leave the next push
 * holding the bill, which is the defect this exists to end (#2676).
 */
export function judgeBundleWeight(i: BundleJudgeInput): BundleVerdict {
  const { measured, committed, base, baseSha, accept } = i;

  if (committed === null) {
    if (!i.committedReadable) {
      return {
        kind: "no-record",
        refuse: true,
        lines: [
          `bundle-budget: the pushed commit carries no ${BUNDLE_RECORD_PATH}, so there is nothing to hold the next push to. This build weighs ${fmt(measured)} bytes gzipped.`,
          ...rerecord(measured),
        ],
      };
    }
    return {
      kind: "record-unreadable",
      refuse: true,
      lines: [
        `bundle-budget: ${BUNDLE_RECORD_PATH} in the pushed commit has no readable \`total: <bytes>\` line. This build weighs ${fmt(measured)} bytes gzipped.`,
        ...rerecord(measured),
      ],
    };
  }

  const drift = measured - committed;
  if (Math.abs(drift) > NOISE_BAND_BYTES) {
    const grew = drift > 0;
    return {
      kind: grew ? "record-behind-build" : "record-ahead-of-build",
      refuse: true,
      lines: [
        grew
          ? `bundle-budget: this commit's client bundle weighs ${fmt(measured)} bytes gzipped and its record still says ${fmt(committed)} (+${fmt(drift)}).`
          : `bundle-budget: this commit's client bundle weighs ${fmt(measured)} bytes gzipped, less than the ${fmt(committed)} its record says (${fmt(drift)}).`,
        `The record must carry the weight of the commit it is in, within ${fmt(NOISE_BAND_BYTES)} bytes, so the change that moves the bundle moves the record and the next push is not judged against a total main has already left behind.`,
        grew
          ? "If this branch changed no client code, main's record is behind main's own build; re-recording here corrects it."
          : "Recording a saving keeps it: left unrecorded, later growth would spend it unseen.",
        ...rerecord(measured),
      ],
    };
  }

  if (baseSha === null) {
    return {
      kind: "no-merge-base",
      refuse: false,
      lines: [
        `bundle-budget: the record carries this build (${fmt(measured)} bytes gzipped). No merge base with origin/main was found, so growth against main was not judged.`,
      ],
    };
  }
  if (base === null) {
    return {
      kind: "no-base-record",
      refuse: false,
      lines: [
        `bundle-budget: the record carries this build (${fmt(measured)} bytes gzipped). The merge base ${baseSha.slice(0, 12)} has no readable ${BUNDLE_RECORD_PATH}, so growth against main was not judged.`,
      ],
    };
  }

  const growth = measured - base;
  const pct = base > 0 ? (growth / base) * 100 : Number.POSITIVE_INFINITY;
  const pctText = Number.isFinite(pct) ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : "more than any margin";
  const vsMain = `against ${fmt(base)} at the merge base ${baseSha.slice(0, 12)}`;

  if (growth > MARGIN_ABS_BYTES && pct > MARGIN_PCT) {
    if (accept) {
      return {
        kind: "accepted-growth",
        refuse: false,
        lines: [
          `bundle-budget: accepted growth to ${fmt(measured)} bytes gzipped (+${fmt(growth)}, ${pctText}) ${vsMain}, and the record carries it.`,
        ],
      };
    }
    return {
      kind: "grew-past-margin",
      refuse: true,
      lines: [
        `PUSH BLOCKED: the client bundle grew to ${fmt(measured)} bytes gzipped (+${fmt(growth)}, ${pctText}) ${vsMain}, past the budget margin (${MARGIN_PCT}% and ${fmt(MARGIN_ABS_BYTES)} bytes, both exceeded).`,
        "Find what joined the client bundle (a dependency imported from a client component or the embed is the usual cause) and keep it off the hot path, then push again.",
        "If the growth is intended, explain why to the user first, then push with ACCEPT_BUNDLE_GROWTH=1 git push ...",
      ],
    };
  }

  if (growth > 0) {
    return {
      kind: "within-margin",
      refuse: false,
      lines: [
        `bundle-budget: the client bundle is ${fmt(measured)} bytes gzipped (+${fmt(growth)}, ${pctText}) ${vsMain}, inside the margin, and the record carries it.`,
      ],
    };
  }
  if (growth < 0) {
    return {
      kind: "shrank",
      refuse: false,
      lines: [
        `bundle-budget: the client bundle is ${fmt(measured)} bytes gzipped (${fmt(growth)}, ${pctText}) ${vsMain}, and the record carries the saving.`,
      ],
    };
  }
  return {
    kind: "unchanged",
    refuse: false,
    lines: [`bundle-budget: the client bundle is unchanged at ${fmt(measured)} bytes gzipped ${vsMain}.`],
  };
}
