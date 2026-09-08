// Every writer of an agent's week names itself (#1753). Run:
//   node --experimental-strip-types --import ./scripts/register-paths.mjs scripts/test-hours-source-stamp.ts
//
// The stamp lives inside `replace_availability_rules`, which REQUIRES a source, so
// a caller that omits `p_source` fails at the call. But it fails at RUNTIME, in
// whichever action or script reaches it first, and supabase-js does not type
// check rpc() argument names. This scan fails the build instead, and it also
// covers the one path that writes rules without the RPC (the seeding insert in
// schedule.ts), which must stamp the row itself.
//
// Callers are ENUMERATED from the source tree by the RPC name, never listed by
// hand, so a new caller is covered by construction rather than exempt (L96).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assert, eq, finish } from "./lib/harness.ts";
import { HOURS_SOURCES } from "@/lib/monitor/unset-hours";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/^test-/.test(name)) out.push(p);
  }
  return out;
}

/** Each rpc("replace_availability_rules", {...}) call: the object literal that follows. */
export function rpcCallArgs(source: string): string[] {
  const out: string[] = [];
  const re = /rpc\(\s*"replace_availability_rules"\s*,\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

const SOURCE_LITERAL = new RegExp(`p_source:\\s*(?:"(${HOURS_SOURCES.join("|")})"|source\\b)`);

// --- positive controls: the scan catches what it is for --------------------------------
{
  eq(rpcCallArgs(`await db.rpc("replace_availability_rules", { p_schedule_id: id, p_rules: r });`).length, 1, "finds a call");
  assert(!SOURCE_LITERAL.test(rpcCallArgs(`db.rpc("replace_availability_rules", { p_schedule_id: id, p_rules: r })`)[0]), "a call with no source is caught");
  assert(!SOURCE_LITERAL.test(`p_source: "made-up"`), "a source outside the vocabulary is caught");
  assert(SOURCE_LITERAL.test(`p_source: "calcom-import"`), "a named source passes");
  assert(SOURCE_LITERAL.test(`p_source: source,`), "a source threaded through a parameter passes");
}

// --- the real tree -----------------------------------------------------------------------
{
  const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))];
  let calls = 0;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const args of rpcCallArgs(text)) {
      calls++;
      assert(SOURCE_LITERAL.test(args), `${relative(ROOT, f)}: replace_availability_rules is called with a p_source from the vocabulary`);
    }
  }
  assert(calls >= 3, `the scan read the real callers (found ${calls}; the editors, the seed fill and the import make at least three)`);

  // The one writer that bypasses the RPC: the seeding insert for a brand new
  // schedule row must stamp the row itself.
  const schedule = readFileSync(join(ROOT, "src/lib/schedule.ts"), "utf8");
  assert(/hours_source:\s*"seed"/.test(schedule), "the seeded schedule row is stamped seed");
}

finish();
