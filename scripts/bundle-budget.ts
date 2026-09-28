// The client bundle budget's command line (#2676). The rule is in
// scripts/lib/bundle-budget.ts; this only reads files and maps verdicts to exits.
//
//   judge  --tree DIR --base-file FILE --base-sha SHA [--accept]
//          Weigh DIR's built client chunks, read DIR's committed record, and judge
//          both against the record at the merge base (FILE, absent when the merge
//          base carries none; SHA empty when no merge base was found). The
//          pre-push gate runs this from the pushed tree, so the rule and the record
//          both come from the revision being judged.
//   record TOTAL [--file PATH]
//          Write TOTAL as the record (default: the repo's record file). The gate
//          prints this command, with the total it just measured, when it refuses.
//          `pnpm bundle:record TOTAL`.
//
// Exits: 0 passed or written, 2 refused by the rule, 3 could not judge (bad
// arguments, or a tree with no client chunks, which in the gate means the build
// shape changed). The hook fails the push on 2 and on 3.
//
// Node builtins and relative imports only, so it runs on bare node.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUNDLE_RECORD_PATH,
  formatBundleRecord,
  judgeBundleWeight,
  parseBundleRecord,
  weighChunks,
} from "./lib/bundle-budget.ts";

const USAGE =
  "usage: bundle-budget.ts judge --tree DIR --base-file FILE --base-sha SHA [--accept]\n" +
  "       bundle-budget.ts record TOTAL [--file PATH]";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function judge(args: string[]): number {
  const tree = flag(args, "--tree");
  const baseFile = flag(args, "--base-file");
  const baseShaArg = flag(args, "--base-sha");
  if (!tree || baseFile === undefined || baseShaArg === undefined) {
    console.log(`bundle-budget: the arguments could not be read, so the bundle was not judged.\n${USAGE}`);
    return 3;
  }
  const weighed = weighChunks(tree);
  if (!weighed.ok) {
    console.log(
      `bundle-budget: not weighed, because ${weighed.why}. The build has just succeeded, so the build's output has moved and this gate must be pointed at it.`,
    );
    return 3;
  }
  const recordPath = join(tree, BUNDLE_RECORD_PATH);
  const hasRecord = existsSync(recordPath);
  const committed = hasRecord ? parseBundleRecord(readFileSync(recordPath, "utf8")) : null;
  const base = baseFile !== "" && existsSync(baseFile) ? parseBundleRecord(readFileSync(baseFile, "utf8")) : null;
  const verdict = judgeBundleWeight({
    measured: weighed.total,
    committed,
    committedReadable: hasRecord,
    base,
    baseSha: baseShaArg === "" ? null : baseShaArg,
    accept: args.includes("--accept"),
  });
  for (const line of verdict.lines) console.log(line);
  return verdict.refuse ? 2 : 0;
}

function record(args: string[]): number {
  const raw = args[0];
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) === 0) {
    console.log(`bundle-budget: "${raw ?? ""}" is not a whole number of bytes, so nothing was recorded.\n${USAGE}`);
    return 3;
  }
  const target = flag(args, "--file") ?? join(import.meta.dirname, "..", BUNDLE_RECORD_PATH);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, formatBundleRecord(Number(raw)));
  renameSync(tmp, target);
  console.log(`bundle-budget: recorded ${Number(raw).toLocaleString("en-US")} bytes gzipped in ${target}. Commit it with the change.`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
const code = cmd === "judge" ? judge(rest) : cmd === "record" ? record(rest) : (console.log(USAGE), 3);
process.exit(code);
